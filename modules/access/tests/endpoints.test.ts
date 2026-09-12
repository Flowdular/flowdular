import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_PERMISSIONS } from '../src/acl/permissions.ts';
import { createAccessRoutes } from '../src/api/endpoints.ts';
import { ACCESS_LIMITS, type AccessAttestation } from '../src/domain/types.ts';
import {
	openHarness,
	ORIGIN,
	PASSWORD,
	type Harness,
	type Workspace,
} from './support/harness.ts';

let harness: Harness;
let workspace: Workspace;

const PERIOD = { from: '2026-06-01', to: '2026-06-30' } as const;

beforeAll(async () => {
	harness = await openHarness();
	workspace = await harness.signUp('owner@example.com', 'endpoints-one');
});

afterAll(async () => {
	await harness?.dispose();
});

interface AttestationBody {
	readonly attestation: AccessAttestation;
}

interface ListBody {
	readonly items: readonly AccessAttestation[];
	readonly page: { readonly nextCursor: string | null };
}

async function attest(
	session: Workspace,
	body: Record<string, unknown> = { ...PERIOD },
	/* An explicit null is how a case sends no proof at all: passing undefined
	   would take the default and send the session's own token. */
	csrfToken: string | null = session.csrfToken,
): Promise<Response> {
	return harness.call('/api/access/attest', {
		method: 'POST',
		session,
		body,
		...(csrfToken === null ? {} : { csrfToken }),
	});
}

async function attestations(session: Workspace, query = ''): Promise<ListBody> {
	const response = await harness.call(
		'/api/access/attestations' + (query === '' ? '' : `?${query}`),
		{ session },
	);
	return (await response.json()) as ListBody;
}

/** A member of the workspace holding exactly the scopes a case names. */
async function memberSession(
	email: string,
	scopes: readonly string[],
): Promise<Workspace> {
	const owner = await harness.owner(workspace);
	const service = await harness.service();
	const member = await service.createTenantMember(
		{
			tenantId: workspace.tenantId,
			email,
			password: PASSWORD,
			displayName: 'Member Person',
			role: 'member',
		},
		owner,
	);
	await service.setMembershipScopes(owner, member.accountId, scopes);
	return harness.signIn(email, 'endpoints-one');
}

describe('ACCESS-DENY every route answers before it reads anything', () => {
	it('answers 401 without a session on every route', async () => {
		const answers = await Promise.all([
			harness.call('/api/access/review'),
			harness.call('/api/access/diff?from=2026-06-01&to=2026-06-02'),
			harness.call('/api/access/activity?from=2026-06-01&to=2026-06-02'),
			harness.call('/api/access/attestations'),
			harness.call('/api/access/attest', {
				method: 'POST',
				body: { ...PERIOD },
			}),
		]);

		expect(answers.map((response) => response.status)).toEqual([
			401, 401, 401, 401, 401,
		]);
	});

	it('answers 403 for a member that holds neither access permission', async () => {
		const session = await memberSession('plain@example.com', []);

		const review = await harness.call('/api/access/review', { session });

		expect(review.status).toBe(403);
	});

	it('lets a reader read and refuses the attestation it may not record', async () => {
		const session = await memberSession('reader@example.com', [
			ACCESS_PERMISSIONS.read,
		]);

		const review = await harness.call('/api/access/review', { session });
		const recorded = await attest(session);

		expect(review.status).toBe(200);
		expect(recorded.status).toBe(403);
	});
});

describe('ACCESS-CSRF a recorded attestation needs the session proof', () => {
	it('refuses a mutation without the CSRF header and writes nothing', async () => {
		const before = await attestations(workspace);

		const refused = await attest(workspace, { ...PERIOD }, null);
		const after = await attestations(workspace);

		expect(refused.status).toBe(403);
		expect((await refused.json()) as { error: { code: string } }).toMatchObject(
			{ error: { code: 'CSRF_REJECTED' } },
		);
		expect(after.items).toHaveLength(before.items.length);
	});

	it('refuses a mutation from another origin', async () => {
		const refused = await harness.call('/api/access/attest', {
			method: 'POST',
			session: workspace,
			body: { ...PERIOD },
			csrfToken: workspace.csrfToken,
			origin: 'https://attacker.example',
		});

		expect(refused.status).toBe(403);
		expect(ORIGIN).not.toBe('https://attacker.example');
	});
});

describe('ACCESS-ATTEST an attestation records the server own reading', () => {
	it('stores the counts the server computed and ignores any the caller sent', async () => {
		const recorded = await attest(workspace, {
			...PERIOD,
			note: 'Reviewed with the security lead.',
			memberCount: 999,
			tokenCount: 999,
		});
		const body = (await recorded.json()) as AttestationBody;

		expect(recorded.status).toBe(201);
		expect(body.attestation).toMatchObject({
			reviewerAccountId: workspace.accountId,
			reviewerLabel: 'owner@example.com',
			periodFrom: '2026-06-01T00:00:00.000Z',
			periodTo: '2026-06-30T23:59:59.999Z',
			note: 'Reviewed with the security lead.',
			tokenCount: 0,
		});
		expect(body.attestation.memberCount).toBeGreaterThan(0);
		expect(body.attestation.memberCount).not.toBe(999);
	});

	it('refuses a note longer than the bound', async () => {
		const refused = await attest(workspace, {
			...PERIOD,
			note: 'x'.repeat(ACCESS_LIMITS.note + 1),
		});

		expect(refused.status).toBe(400);
	});

	it('refuses a period that is not a pair of calendar dates', async () => {
		const refused = await attest(workspace, { from: '2026-06-01', to: 'soon' });

		expect(refused.status).toBe(400);
	});
});

describe('ACCESS-ATTEST-APPEND-ONLY the ledger only grows', () => {
	it('appends a second attestation for the same period and leaves the first alone', async () => {
		const first = ((await (await attest(workspace)).json()) as AttestationBody)
			.attestation;
		const second = (
			(await (
				await attest(workspace, { ...PERIOD, note: 'Second pass.' })
			).json()) as AttestationBody
		).attestation;

		const listed = await attestations(workspace);
		const kept = listed.items.find((item) => item.id === first.id);

		expect(second.id).not.toBe(first.id);
		expect(kept).toEqual(first);
	});

	it('publishes no route that could change or remove one', () => {
		const routes = createAccessRoutes(harness.auth, harness.access);

		expect(
			routes
				.map((route) => `${[...route.methods].sort().join('|')} ${route.path}`)
				.sort(),
		).toEqual([
			'GET /api/access/activity',
			'GET /api/access/attestations',
			'GET /api/access/diff',
			'GET /api/access/review',
			'POST /api/access/attest',
		]);
	});

	it('pages the ledger newest first without repeating a row', async () => {
		const page = await attestations(workspace, 'limit=2');
		const next = await attestations(
			workspace,
			`limit=2&cursor=${encodeURIComponent(page.page.nextCursor!)}`,
		);

		expect(page.items).toHaveLength(2);
		expect(page.items.map((item) => item.createdAt)).toEqual(
			[...page.items.map((item) => item.createdAt)].sort((a, b) => b - a),
		);
		expect(
			next.items.filter((item) =>
				page.items.some((seen) => seen.id === item.id),
			),
		).toEqual([]);
	});
});

describe('ACCESS-TENANT-BOUNDARY a workspace sees only its own ledger', () => {
	it('answers one workspace attestations to that workspace alone', async () => {
		const other = await harness.signUp('other@example.com', 'endpoints-two');
		await attest(other, { ...PERIOD, note: 'Other workspace.' });

		const mine = await attestations(workspace);
		const theirs = await attestations(other);

		expect(theirs.items.map((item) => item.note)).toEqual(['Other workspace.']);
		expect(mine.items.some((item) => item.tenantId === other.tenantId)).toBe(
			false,
		);
		expect(
			mine.items.every((item) => item.tenantId === workspace.tenantId),
		).toBe(true);
	});
});
