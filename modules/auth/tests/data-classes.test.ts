import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataClassRegistry } from '@flowdular/kernel';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
	authDataClasses,
	AUTH_SWEEP_LIMIT,
	SECURITY_RETENTION_DAYS,
	SESSION_RETENTION_DAYS,
} from '../src/services/data-classes.ts';
import type { AuthRepository } from '../src/services/repository.ts';
import {
	closeAuthTestDatabases,
	createAuthTestDatabase,
	type AuthTestDatabase,
} from './support/database.ts';

/**
 * The repository this module is checked out in. A sandbox session copies the
 * module into a workspace of its own that carries no other module, and the
 * audit.core declaration is not there to read; in the repository it is.
 */
function repositoryRoot(): string | undefined {
	let directory = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 8; depth += 1) {
		if (existsSync(join(directory, 'modules/audit/src/settings.ts'))) {
			return directory;
		}
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
	return undefined;
}

const root = repositoryRoot();

/** The maximum audit.core declares for sweepBatchSize, read from its source. */
function auditSweepBatchSizeMaximum(workspaceRoot: string): number {
	const source = readFileSync(
		join(workspaceRoot, 'modules/audit/src/settings.ts'),
		'utf8',
	);
	const declaration = /sweepBatchSize:\s*\{([^}]*)\}/.exec(source)?.[1];
	const maximum = declaration
		? /\bmax:\s*([\d_]+)/.exec(declaration)?.[1]
		: undefined;
	if (maximum === undefined) {
		throw new Error('audit.core declares no sweepBatchSize maximum.');
	}
	return Number(maximum.replaceAll('_', ''));
}

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);

let database: AuthTestDatabase | undefined;
afterEach(async () => {
	await database?.dispose();
	database = undefined;
});
afterAll(closeAuthTestDatabases);

function declarations(repository: AuthRepository) {
	const registry = createDataClassRegistry();
	registry.declare(
		'auth.core',
		authDataClasses(async () => repository),
	);
	return registry;
}

function declared(repository: AuthRepository, key: string) {
	const entry = declarations(repository)
		.list()
		.find((module) => module.moduleId === 'auth.core')
		?.classes.find((declaration) => declaration.key === key);
	if (!entry) throw new Error(`auth.core declared no ${key} class.`);
	return entry;
}

/**
 * One workspace with an expired session, a session that expired yesterday, a
 * live session, an expired token, a revoked token, a usable token and three
 * audit rows of different ages. `ageDays` is how long ago the row went stale.
 */
async function seedWorkspace(
	repository: AuthRepository,
	label: string,
): Promise<{ readonly tenantId: string; readonly accountId: string }> {
	/* The workspace is created through the repository rather than sign-up: a
	   sign-up opens a session and appends an audit row of its own, and every
	   count below is about the rows this fixture seeds. */
	const owner = await repository.createAccountWithTenant({
		accountId: `${label}-account`,
		tenantId: `${label}-tenant`,
		email: `${label}@example.test`,
		normalizedEmail: `${label}@example.test`,
		passwordHash: 'fixture-hash',
		displayName: 'Owner',
		organizationName: label,
		organizationSlug: label,
		role: 'owner',
		scopes: ['auth.profile.read'],
		createdAt: NOW - 700 * DAY_MS,
	});
	const session = async (name: string, expiredDaysAgo: number) => {
		await repository.createSession({
			id: `${label}-${name}`,
			tokenHash: `${label}-${name}-hash`,
			accountId: owner.accountId,
			tenantId: owner.tenantId,
			csrfToken: `${label}-${name}-csrf`,
			createdAt: NOW - (expiredDaysAgo + 1) * DAY_MS,
			expiresAt: NOW - expiredDaysAgo * DAY_MS,
		});
	};
	await session('stale', 40);
	await session('recent', 1);
	await session('live', -1);
	const token = async (
		name: string,
		expiresAt: number | null,
	): Promise<string> => {
		const record = await repository.createApiToken({
			id: `${label}-${name}`,
			tenantId: owner.tenantId,
			accountId: owner.accountId,
			label: name,
			prefix: `fdp_${name}`,
			tokenHash: `${label}-${name}-hash`,
			scopes: ['auth.profile.read'],
			createdBy: owner.accountId,
			createdAt: NOW - 600 * DAY_MS,
			expiresAt,
		});
		return record.id;
	};
	await token('expired', NOW - 500 * DAY_MS);
	await token('current', NOW + 30 * DAY_MS);
	const revoked = await token('revoked', null);
	await repository.revokeApiToken(
		owner.tenantId,
		revoked,
		NOW - 500 * DAY_MS,
		owner.accountId,
	);
	for (const [name, daysAgo] of [
		['old', 500],
		['middle', 10],
		['fresh', 1],
	] as const) {
		await repository.appendAudit({
			tenantId: owner.tenantId,
			actorAccountId: owner.accountId,
			actorLabel: `${label}@example.test`,
			actorKind: 'user',
			actorRunId: null,
			action: `auth.${name}`,
			subjectType: 'account',
			subjectId: owner.accountId,
			metadata: {},
			occurredAt: NOW - daysAgo * DAY_MS,
		});
	}
	return { tenantId: owner.tenantId, accountId: owner.accountId };
}

async function collect(
	declaration: ReturnType<typeof declared>,
	tenantId: string,
): Promise<{
	readonly rows: Record<string, unknown>[];
	readonly summary: { rows: number; from: Date | null; to: Date | null };
}> {
	const rows: Record<string, unknown>[] = [];
	const summary = await declaration.export!({
		tenantId,
		sink: {
			write: async (row) => {
				rows.push(row);
			},
		},
	});
	return { rows, summary };
}

describe('auth.core data classes', () => {
	it('declares the classes auth.core keeps by age, with their retention', async () => {
		database = await createAuthTestDatabase();

		expect(
			declarations(database.repository)
				.list()
				.flatMap((module) =>
					module.classes.map((declaration) => [
						`${module.moduleId}.${declaration.key}`,
						declaration.defaultRetentionDays,
						declaration.exportable,
					]),
				),
		).toEqual([
			['auth.core.sessions', SESSION_RETENTION_DAYS, true],
			['auth.core.api-tokens', SECURITY_RETENTION_DAYS, true],
			['auth.core.audit-events', SECURITY_RETENTION_DAYS, true],
		]);
	});

	it('sweeps only the sessions that expired before the cutoff, in the named workspace', async () => {
		database = await createAuthTestDatabase();
		const first = await seedWorkspace(database.repository, 'contoso');
		const second = await seedWorkspace(database.repository, 'fabrikam');
		const sessions = declared(database.repository, 'sessions');

		expect(
			await sessions.sweep!({
				tenantId: first.tenantId,
				cutoff: new Date(NOW - SESSION_RETENTION_DAYS * DAY_MS),
				limit: 100,
			}),
		).toEqual({ removed: 1 });

		const kept = await collect(sessions, first.tenantId);
		expect(kept.rows.map((row) => row['id'])).toEqual([
			'contoso-live',
			'contoso-recent',
		]);
		/* The other workspace keeps a session of exactly the same age. */
		expect(
			(await collect(sessions, second.tenantId)).rows.map((row) => row['id']),
		).toHaveLength(3);
	});

	it('removes no more sessions than the limit it was given', async () => {
		database = await createAuthTestDatabase();
		const { tenantId } = await seedWorkspace(database.repository, 'contoso');
		const sessions = declared(database.repository, 'sessions');

		expect(
			await sessions.sweep!({
				tenantId,
				cutoff: new Date(NOW),
				limit: 1,
			}),
		).toEqual({ removed: 1 });
		expect((await collect(sessions, tenantId)).summary.rows).toBe(2);
	});

	it('sweeps a retired token and never one that still authenticates', async () => {
		database = await createAuthTestDatabase();
		const first = await seedWorkspace(database.repository, 'contoso');
		const second = await seedWorkspace(database.repository, 'fabrikam');
		const tokens = declared(database.repository, 'api-tokens');

		expect(
			await tokens.sweep!({
				tenantId: first.tenantId,
				cutoff: new Date(NOW - SECURITY_RETENTION_DAYS * DAY_MS),
				limit: 100,
			}),
		).toEqual({ removed: 2 });

		expect(
			(await collect(tokens, first.tenantId)).rows.map((row) => row['id']),
		).toEqual(['contoso-current']);
		expect(
			(await collect(tokens, second.tenantId)).rows.map((row) => row['id']),
		).toHaveLength(3);
	});

	it('sweeps the audit rows older than the cutoff, in the named workspace', async () => {
		database = await createAuthTestDatabase();
		const first = await seedWorkspace(database.repository, 'contoso');
		const second = await seedWorkspace(database.repository, 'fabrikam');
		const events = declared(database.repository, 'audit-events');

		expect(
			await events.sweep!({
				tenantId: first.tenantId,
				cutoff: new Date(NOW - SECURITY_RETENTION_DAYS * DAY_MS),
				limit: 100,
			}),
		).toEqual({ removed: 1 });

		expect(
			(await collect(events, first.tenantId)).rows.map((row) => row['action']),
		).toEqual(['auth.middle', 'auth.fresh']);
		expect(
			(await collect(events, second.tenantId)).rows.map((row) => row['action']),
		).toEqual(['auth.old', 'auth.middle', 'auth.fresh']);
	});

	it('exports one workspace only, and no value that authenticates anything', async () => {
		database = await createAuthTestDatabase();
		const first = await seedWorkspace(database.repository, 'contoso');
		await seedWorkspace(database.repository, 'fabrikam');

		const sessions = await collect(
			declared(database.repository, 'sessions'),
			first.tenantId,
		);
		const tokens = await collect(
			declared(database.repository, 'api-tokens'),
			first.tenantId,
		);
		const events = await collect(
			declared(database.repository, 'audit-events'),
			first.tenantId,
		);

		for (const row of [...sessions.rows, ...tokens.rows, ...events.rows]) {
			expect(row['tenantId']).toBe(first.tenantId);
			expect(Object.keys(row)).not.toContain('tokenHash');
			expect(Object.keys(row)).not.toContain('csrfToken');
			expect(JSON.stringify(row)).not.toContain('-hash');
			expect(JSON.stringify(row)).not.toContain('-csrf');
		}
		expect(sessions.summary.rows).toBe(3);
		expect(tokens.summary.rows).toBe(3);
		expect(events.summary.rows).toBe(3);
		expect(events.summary.from?.toISOString()).toBe(
			new Date(NOW - 500 * DAY_MS).toISOString(),
		);
		expect(events.summary.to?.toISOString()).toBe(
			new Date(NOW - 1 * DAY_MS).toISOString(),
		);
	});

	it('walks the export in pages rather than one query', async () => {
		database = await createAuthTestDatabase();
		const { tenantId } = await seedWorkspace(database.repository, 'contoso');
		const registry = createDataClassRegistry();
		const repository = database.repository;
		registry.declare(
			'auth.core',
			authDataClasses(async () => repository, 1),
		);
		const sessions = registry
			.list()[0]!
			.classes.find((declaration) => declaration.key === 'sessions')!;
		const rows: Record<string, unknown>[] = [];

		const summary = await sessions.export!({
			tenantId,
			sink: {
				write: async (row) => {
					rows.push(row);
				},
			},
		});

		expect(summary.rows).toBe(3);
		expect(new Set(rows.map((row) => row['id'])).size).toBe(3);
	});

	it('exports nothing and reports no range for a workspace without rows', async () => {
		database = await createAuthTestDatabase();

		for (const key of ['sessions', 'api-tokens', 'audit-events']) {
			expect(
				await collect(declared(database.repository, key), 'tenant-empty'),
			).toEqual({ rows: [], summary: { rows: 0, from: null, to: null } });
		}
	});

	/* A sweep batch is the audit.core sweepBatchSize setting, and auth.core caps
	   whatever it is handed. Capping below that setting's own maximum would make
	   a workspace that raises it sweep fewer rows per call than it asked for,
	   without saying so. auth.core must not depend on audit.core, so the cap is
	   repeated in data-classes.ts; this reads the declaration audit.core ships
	   rather than a second copy of the number, which would agree with itself
	   however far the two drift apart. */
	it.skipIf(root === undefined)(
		'accepts a sweep batch as large as the audit retention setting allows',
		() => {
			expect(AUTH_SWEEP_LIMIT).toBe(auditSweepBatchSizeMaximum(root!));
		},
	);
});

describe('auth.core erasure', () => {
	it('removes the subject sessions and tokens of one workspace and leaves another workspace alone', async () => {
		database = await createAuthTestDatabase();
		const first = await seedWorkspace(database.repository, 'contoso');
		const second = await seedWorkspace(database.repository, 'fabrikam');
		const sessions = declared(database.repository, 'sessions');
		const tokens = declared(database.repository, 'api-tokens');

		/* Live rows go too: an erased subject keeps no way into the workspace. */
		expect(
			await sessions.erase!({
				tenantId: first.tenantId,
				subject: { accountId: first.accountId },
				limit: 100,
			}),
		).toEqual({ removed: 3 });
		expect(
			await tokens.erase!({
				tenantId: first.tenantId,
				subject: { accountId: first.accountId },
				limit: 100,
			}),
		).toEqual({ removed: 3 });

		expect((await collect(sessions, first.tenantId)).rows).toEqual([]);
		expect((await collect(tokens, first.tenantId)).rows).toEqual([]);
		expect((await collect(sessions, second.tenantId)).summary.rows).toBe(3);
		expect((await collect(tokens, second.tenantId)).summary.rows).toBe(3);
	});

	it('leaves the rows of another subject in the same workspace', async () => {
		database = await createAuthTestDatabase();
		const { tenantId, accountId } = await seedWorkspace(
			database.repository,
			'contoso',
		);
		await database.repository.createAccountInTenant({
			accountId: 'contoso-other',
			tenantId,
			email: 'other@example.test',
			normalizedEmail: 'other@example.test',
			passwordHash: 'fixture-hash',
			displayName: 'Other',
			role: 'member',
			roleId: null,
			scopes: ['auth.profile.read'],
			createdAt: NOW,
		});
		await database.repository.createSession({
			id: 'contoso-other-session',
			tokenHash: 'contoso-other-hash',
			accountId: 'contoso-other',
			tenantId,
			csrfToken: 'contoso-other-csrf',
			createdAt: NOW,
			expiresAt: NOW + DAY_MS,
		});
		const sessions = declared(database.repository, 'sessions');

		expect(
			await sessions.erase!({
				tenantId,
				subject: { accountId },
				limit: 100,
			}),
		).toEqual({ removed: 3 });

		expect(
			(await collect(sessions, tenantId)).rows.map((row) => row['id']),
		).toEqual(['contoso-other-session']);
	});

	it('reports a full batch as truncated so the caller comes back', async () => {
		database = await createAuthTestDatabase();
		const { tenantId, accountId } = await seedWorkspace(
			database.repository,
			'contoso',
		);
		const sessions = declared(database.repository, 'sessions');

		expect(
			await sessions.erase!({ tenantId, subject: { accountId }, limit: 2 }),
		).toEqual({ removed: 2, truncated: true });
		expect(
			await sessions.erase!({ tenantId, subject: { accountId }, limit: 2 }),
		).toEqual({ removed: 1 });
		expect((await collect(sessions, tenantId)).rows).toEqual([]);
	});

	/* The audit spec excludes audit events from erasure: they are the evidence
	   the data lifecycle of a workspace happened, and retention bounds them. */
	it('declares no erase for the audit events', async () => {
		database = await createAuthTestDatabase();

		expect(declared(database.repository, 'audit-events').erase).toBeUndefined();
		expect(declared(database.repository, 'sessions').erase).toBeTypeOf(
			'function',
		);
		expect(declared(database.repository, 'api-tokens').erase).toBeTypeOf(
			'function',
		);
	});
});
