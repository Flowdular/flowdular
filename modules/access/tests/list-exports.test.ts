import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_PERMISSIONS } from '../src/acl/permissions.ts';
import { AccessService } from '../src/services/access-service.ts';
import type {
	AccessDirectory,
	DirectoryMember,
} from '../src/services/directory.ts';
import { accessListExports } from '../src/services/list-exports.ts';
import { ACCESS_LIMITS } from '../src/domain/types.ts';
import {
	openAccessTestDatabase,
	type AccessTestDatabase,
} from './support/database.ts';

let shared: AccessTestDatabase;

beforeAll(async () => {
	shared = await openAccessTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

const PRINCIPAL = {
	accountId: 'account-1',
	tenantId: 'tenant-a',
	scopes: [ACCESS_PERMISSIONS.read],
};

function member(accountId: string, displayName = accountId): DirectoryMember {
	return {
		accountId,
		email: `${accountId}@example.com`,
		displayName,
		role: 'member',
		roleId: null,
		status: 'active',
		membershipStatus: 'active',
		scopes: [ACCESS_PERMISSIONS.read],
	};
}

/* auth.core orders the unpaged roll by display name, which is what the review
   screen reads. The paged surface orders by account id. Keeping the two apart
   here is what makes a walk that read the wrong one observable. */
function byDisplayName(
	members: readonly DirectoryMember[],
): readonly DirectoryMember[] {
	return [...members].sort((left, right) =>
		left.displayName < right.displayName ? -1 : 1,
	);
}

/**
 * The member page auth.core answers: ordered by account id, starting strictly
 * after the cursor, bounded by the limit. The unpaged roll stays what the review
 * screen reads, so a case can tell the two apart.
 */
function memberPageOf(
	members: readonly DirectoryMember[],
): AccessDirectory['memberPage'] {
	const ordered = [...members].sort((left, right) =>
		left.accountId < right.accountId ? -1 : 1,
	);
	return async (_tenantId, cursor, limit) => {
		const start =
			cursor === null
				? 0
				: ordered.findIndex((member) => member.accountId > cursor);
		const from = start === -1 ? ordered.length : start;
		const page = ordered.slice(from, from + limit);
		const last = page.at(-1);
		return {
			members: page,
			nextCursor:
				last && from + page.length < ordered.length ? last.accountId : null,
		};
	};
}

function exportsOf(members: readonly DirectoryMember[], now = () => 1_000) {
	const directory: AccessDirectory = {
		members: async () => byDisplayName(members),
		memberPage: memberPageOf(members),
		roles: async () => [],
		tokens: async () => [],
		providers: async () => [],
		auditPage: async () => [],
	};
	const service = new AccessService({
		repository: shared.repository,
		directory,
		now,
	});
	const defined = accessListExports(async () => service);
	return {
		service,
		review: defined.find((entry) => entry.id === 'access.core.review')!,
		attestations: defined.find(
			(entry) => entry.id === 'access.core.attestations',
		)!,
	};
}

describe('the review list export', () => {
	it('declares the columns a reviewer reads and the permission the list requires', () => {
		const { review } = exportsOf([]);

		expect(review.permission).toBe(ACCESS_PERMISSIONS.read);
		expect(review.columns.map((column) => column.key)).toEqual([
			'member',
			'email',
			'role',
			'accountStatus',
			'membershipStatus',
			'scopes',
			'extraScopes',
		]);
		expect(review.header).toContain('Member');
	});

	it('walks the memberships page by page without repeating one', async () => {
		const { review } = exportsOf([
			member('ada'),
			member('grace'),
			member('linus'),
		]);

		const first = await review.page(PRINCIPAL, null, 2);
		const second = await review.page(PRINCIPAL, first.nextCursor, 2);

		expect(first.rows).toBe(2);
		expect(first.records[0]).toContain('ada@example.com');
		expect(first.nextCursor).toBe('grace');
		expect(second.rows).toBe(1);
		expect(second.records[0]).toContain('linus@example.com');
		expect(second.nextCursor).toBeNull();
	});

	/* The keyset is the account id, so the row it names does not have to still be
	   there: the next page is whatever sorts after it. */
	it('pages on after the member it was walking from left the workspace', async () => {
		const { review } = exportsOf([member('ada'), member('linus')]);

		const page = await review.page(PRINCIPAL, 'grace', 2);

		expect(page.rows).toBe(1);
		expect(page.records[0]).toContain('linus@example.com');
		expect(page.nextCursor).toBeNull();
	});

	/* ACCESS-REVIEW-EXPORT: the review screen lists at most ACCESS_LIMITS.members
	   and says it was capped. A file cannot be capped, so the walk reads the
	   uncapped member page and a workspace past that bound exports whole. */
	it('writes every member of a workspace larger than the review lists', async () => {
		const roll = Array.from(
			{ length: ACCESS_LIMITS.members + 21 },
			(_row, index) => member(`account-${String(index).padStart(4, '0')}`),
		);
		const { service, review } = exportsOf(roll);
		expect((await service.review('tenant-a')).capped).toContain('members');

		const written: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const page: Awaited<ReturnType<typeof review.page>> = await review.page(
				PRINCIPAL,
				cursor,
				200,
			);
			written.push(...page.records);
			cursor = page.nextCursor;
			pages += 1;
		} while (cursor !== null);

		expect(pages).toBe(3);
		expect(written).toHaveLength(roll.length);
		expect(new Set(written).size).toBe(roll.length);
		expect(written[0]).toContain('account-0000@example.com');
		expect(written.at(-1)).toContain(
			`account-${String(roll.length - 1).padStart(4, '0')}@example.com`,
		);
	});

	/* ACCESS-REVIEW-EXPORT: the keyset is the account id and not the display
	   name the roll is ordered by, so a rename between two pages cannot move a
	   member across the boundary and have them written twice or dropped. */
	it('writes a member renamed mid-walk exactly once', async () => {
		const roll = [
			member('account-1', 'Cara'),
			member('account-2', 'Bea'),
			member('account-3', 'Ana'),
		];
		const directory: AccessDirectory = {
			members: async () => byDisplayName(roll),
			memberPage: memberPageOf(roll),
			roles: async () => [],
			tokens: async () => [],
			providers: async () => [],
			auditPage: async () => [],
		};
		const review = accessListExports(async () =>
			Promise.resolve(
				new AccessService({
					repository: shared.repository,
					directory,
					now: () => 1_000,
				}),
			),
		).find((entry) => entry.id === 'access.core.review')!;

		const first = await review.page(PRINCIPAL, null, 2);
		/* The member the walk has not reached yet is renamed to the end of the
		   display-name order, which is where a walk keyed on that order would
		   read them a second time. */
		roll[2] = member('account-3', 'Zoe');
		directory.members = async () => byDisplayName(roll);
		directory.memberPage = memberPageOf(roll);
		const second = await review.page(PRINCIPAL, first.nextCursor, 2);

		const written = [...first.records, ...second.records];
		expect(written).toHaveLength(3);
		expect(new Set(written).size).toBe(3);
		expect(written.map((record) => record.split(',')[1])).toEqual([
			'account-1@example.com',
			'account-2@example.com',
			'account-3@example.com',
		]);
		expect(second.nextCursor).toBeNull();
	});
});

describe('the attestation list export', () => {
	it('writes one record per recorded attestation, newest first', async () => {
		const { service, attestations } = exportsOf([member('ada')]);
		const window = { from: Date.UTC(2026, 5, 1), to: Date.UTC(2026, 5, 30) };
		const reviewer = { accountId: 'account-1', label: 'ada@example.com' };
		await new AccessService({
			repository: shared.repository,
			directory: {
				members: async () => [member('ada')],
				memberPage: memberPageOf([member('ada')]),
				roles: async () => [],
				tokens: async () => [],
				providers: async () => [],
				auditPage: async () => [],
			},
			now: () => 10,
		}).attest('tenant-a', reviewer, { window, note: 'First' });
		await service.attest('tenant-a', reviewer, { window, note: 'Second' });

		const page = await attestations.page(PRINCIPAL, null, 200);

		expect(page.rows).toBe(2);
		expect(page.records[0]).toContain('Second');
		expect(page.records[1]).toContain('First');
		expect(page.nextCursor).toBeNull();
		expect(attestations.header).toContain('Recorded at');
	});

	it('keeps another workspace out of the file', async () => {
		const { service, attestations } = exportsOf([member('ada')]);
		const window = { from: Date.UTC(2026, 5, 1), to: Date.UTC(2026, 5, 30) };
		await service.attest(
			'tenant-b',
			{ accountId: 'account-2', label: 'other@example.com' },
			{ window, note: 'Theirs' },
		);

		const page = await attestations.page(PRINCIPAL, null, 200);

		expect(page.rows).toBe(0);
		expect(page.nextCursor).toBeNull();
	});
});
