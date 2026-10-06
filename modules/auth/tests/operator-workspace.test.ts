import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type {
	CliExtensionContext,
	CliExtensionResult,
} from '@flowdular/cli-protocol';
import {
	PostgresDatabaseAdapter,
	type DatabaseHandle,
	type DatabaseProvider,
} from '@flowdular/database';
import { createPgliteCluster } from '@flowdular/database-pglite';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import { OWNER_SCOPES } from '../src/acl/scopes.ts';
import {
	GREENFIELD_OPERATOR,
	GREENFIELD_TENANT_SLUGS,
	seedGreenfield,
} from '../src/cli/greenfield.ts';
import { readOperator, setOperator } from '../src/cli/operator.ts';
import { createWorkspace } from '../src/cli/provisioning.ts';
import { createAuthRoutes } from '../src/server/endpoints.ts';
import {
	createAuthRuntime,
	createModuleSettingsRuntime,
} from '../src/server/runtime.ts';
import {
	AuthService,
	type WorkspaceProvisionInput,
} from '../src/services/auth-service.ts';
import {
	DatabaseAuthRepository,
	migrateAuthDatabase,
} from '../src/services/database-repository.ts';
import type { TenantSummary } from '../src/services/repository.ts';
import { fastHash, testRuntime } from './helpers.ts';
import {
	authTestProvider,
	closeAuthTestDatabases,
	createAuthTestDatabase,
	type AuthTestDatabase,
} from './support/database.ts';

const PUBLIC_ORIGIN = 'https://erp.example';
const FIRST_RUN = 'setup:first-run';
const SINGLE_WORKSPACE_RULE = 'auth.core:single-workspace';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(closeAuthTestDatabases);

interface Fixture {
	readonly database: AuthTestDatabase;
	readonly service: AuthService;
}

function serviceOver(repository: DatabaseAuthRepository): AuthService {
	return new AuthService(repository, {
		passwordHash: fastHash,
		publicBaseUrl: PUBLIC_ORIGIN,
	});
}

async function fixture(): Promise<Fixture> {
	const database = await createAuthTestDatabase();
	cleanups.push(() => database.dispose());
	return { database, service: serviceOver(database.repository) };
}

function workspaceInput(
	slug: string,
	operator = FIRST_RUN,
): WorkspaceProvisionInput {
	return {
		name: `Workspace ${slug}`,
		slug,
		ownerEmail: `owner@${slug}.example`,
		ownerDisplayName: 'Ada Owner',
		operator,
	};
}

async function provision(
	service: AuthService,
	slug: string,
	operator = FIRST_RUN,
): Promise<TenantSummary> {
	return (await service.provisionWorkspace(workspaceInput(slug, operator)))
		.workspace;
}

/* A workspace written the way a release without the record wrote it. */
async function legacyWorkspace(
	database: AuthTestDatabase,
	slug: string,
): Promise<string> {
	const tenantId = `tenant-${slug}`;
	await database.repository.createAccountWithTenant({
		accountId: `account-${slug}`,
		tenantId,
		email: `owner@${slug}.example`,
		normalizedEmail: `owner@${slug}.example`,
		passwordHash: 'hash',
		displayName: 'Ada Owner',
		organizationName: `Workspace ${slug}`,
		organizationSlug: slug,
		role: 'owner',
		scopes: OWNER_SCOPES,
		createdAt: 1_000,
	});
	return tenantId;
}

async function operatorEvents(service: AuthService, tenantId: string) {
	const page = await service.queryAudit({ tenantId, limit: 100 });
	return page.events.filter((event) =>
		event.action.startsWith('auth.operator.'),
	);
}

function cliContext(
	databases: DatabaseProvider,
	options: {
		readonly apply?: boolean;
		readonly arguments?: readonly string[];
		readonly flags?: Record<string, string | boolean>;
	} = {},
): CliExtensionContext {
	return {
		workspaceRoot: process.cwd(),
		moduleRoot: process.cwd(),
		apply: options.apply ?? false,
		flags: new Map(Object.entries(options.flags ?? { actor: 'ada' })),
		arguments: options.arguments ?? [],
		databases,
	};
}

async function withMigrator<T>(
	database: AuthTestDatabase,
	body: (handle: DatabaseHandle) => Promise<T>,
): Promise<T> {
	const lease = await database.provider.acquire({
		namespace: 'auth.core',
		purpose: 'migration',
	});
	try {
		return await body(lease.database);
	} finally {
		await lease.release();
	}
}

/* Refuses the assigned event alone, so the write that carries it fails after
   every earlier statement of its transaction ran. */
async function refusingAssignedEvents<T>(
	database: AuthTestDatabase,
	body: () => Promise<T>,
): Promise<T> {
	await withMigrator(database, (migrator) =>
		migrator.execute({
			text: `ALTER TABLE auth_audit ADD CONSTRAINT operator_test_refusal
			       CHECK (action <> 'auth.operator.assigned') NOT VALID`,
		}),
	);
	try {
		return await body();
	} finally {
		await withMigrator(database, (migrator) =>
			migrator.execute({
				text: 'ALTER TABLE auth_audit DROP CONSTRAINT operator_test_refusal',
			}),
		);
	}
}

function interceptWrites(
	real: DatabaseHandle,
	beforeWrite: (tenantId: string) => Promise<void> | void,
): DatabaseHandle {
	const transaction: DatabaseHandle['transaction'] = async (
		operation,
		options,
	) => {
		if (options?.access === 'write') await beforeWrite(options.tenantId ?? '');
		return real.transaction(operation, options);
	};
	return new Proxy(real, {
		get(target, property) {
			if (property === 'transaction') return transaction;
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

/* Holds every write transaction until `parties` of them wait, so each process
   has finished its reads before any of them writes. It opens after a while
   regardless, so an implementation that writes from fewer processes is not
   held forever. */
function writeBarrier(parties: number): () => Promise<void> {
	let arrived = 0;
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	const fallback = setTimeout(open, 5_000);
	return () => {
		arrived += 1;
		if (arrived >= parties) {
			clearTimeout(fallback);
			open();
		}
		return opened;
	};
}

function barrierProvider(
	databases: DatabaseProvider,
	arrive: () => Promise<void>,
): DatabaseProvider {
	return {
		async acquire(request) {
			const lease = await databases.acquire(request);
			if (request.purpose !== 'runtime') return lease;
			return { ...lease, database: interceptWrites(lease.database, arrive) };
		},
		dispose: () => Promise.resolve(),
	};
}

function runtimeOptions(databases: DatabaseProvider) {
	return {
		databases,
		secureCookies: false,
		sessionTtlMs: 60 * 60 * 1000,
		allowSignUp: true,
		emailConfirmation: false,
		signInProviders: [],
	};
}

describe('AUTH-OPERATOR-FIRST-WORKSPACE', () => {
	it('records the first workspace of an empty database with one event naming the provisioning actor', async () => {
		const { service } = await fixture();

		const a = await provision(service, 'workspace-a');

		expect(await service.operatorStanding(a.tenantId)).toBe('own');
		expect(await service.operatorWorkspace()).toEqual({
			workspace: a,
			source: 'first-workspace',
			recordedAt: expect.any(Number),
		});
		expect(await operatorEvents(service, a.tenantId)).toEqual([
			expect.objectContaining({
				action: 'auth.operator.assigned',
				actorKind: 'service',
				actorLabel: FIRST_RUN,
				subjectType: 'tenant',
				subjectId: a.tenantId,
				metadata: { source: 'first-workspace' },
			}),
		]);
	});

	/* AUTH-OPERATOR-WORKSPACE: the command's workspace is the deployment's first. */
	it('records the workspace auth workspace-create makes on an empty deployment', async () => {
		vi.stubEnv('FD_AUTH_PUBLIC_ORIGIN', PUBLIC_ORIGIN);
		const { database, service } = await fixture();

		const created = await createWorkspace(
			cliContext(database.provider, {
				apply: true,
				flags: {
					name: 'Example Operations',
					'owner-email': 'ada.owner@example.com',
					'owner-name': 'Ada Owner',
					actor: 'ada',
				},
			}),
		);

		const { tenantId } = (created.data as { workspace: TenantSummary })
			.workspace;
		expect(await service.operatorStanding(tenantId)).toBe('own');
		expect(await operatorEvents(service, tenantId)).toEqual([
			expect.objectContaining({
				actorLabel: 'cli:ada',
				metadata: { source: 'first-workspace' },
			}),
		]);
	});

	it('leaves no workspace, record or event when the creating transaction fails, and records on the retry', async () => {
		const { database } = await fixture();
		const attempted = new Set<string>();
		const service = serviceOver(
			new DatabaseAuthRepository({
				runtime: interceptWrites(database.runtime, (tenantId) => {
					attempted.add(tenantId);
				}),
				background: database.background,
			}),
		);

		await refusingAssignedEvents(database, () =>
			expect(provision(service, 'workspace-a')).rejects.toThrow(),
		);

		expect(attempted.size).toBe(1);
		const [failed] = [...attempted];
		expect(await database.repository.hasAnyTenant()).toBe(false);
		expect(await service.findTenant(failed!)).toBeNull();
		expect(await service.operatorWorkspace()).toBeNull();
		expect(
			(await service.queryAudit({ tenantId: failed!, limit: 10 })).events,
		).toEqual([]);

		const retried = await provision(service, 'workspace-a');
		expect(await service.operatorStanding(retried.tenantId)).toBe('own');
		expect(await operatorEvents(service, retried.tenantId)).toHaveLength(1);
	});

	it('keeps one record when two first provisionings race on an empty database', async () => {
		const { database, service } = await fixture();
		const arrive = writeBarrier(2);
		const racing = () =>
			serviceOver(
				new DatabaseAuthRepository({
					runtime: interceptWrites(database.runtime, arrive),
					background: database.background,
				}),
			);

		const [a, b] = await Promise.all([
			provision(racing(), 'workspace-a'),
			provision(racing(), 'workspace-b'),
		]);

		const standings = [
			await service.operatorStanding(a.tenantId),
			await service.operatorStanding(b.tenantId),
		].sort();
		expect(standings).toEqual(['other', 'own']);
		expect([
			...(await operatorEvents(service, a.tenantId)),
			...(await operatorEvents(service, b.tenantId)),
		]).toHaveLength(1);
	});
});

describe('AUTH-OPERATOR-LATER-WORKSPACE', () => {
	it('keeps the record on A through a sign-up, a provisioning and a just-in-time join', async () => {
		const { service } = await fixture();
		const a = await provision(service, 'workspace-a');

		const b = (
			await service.signUp({
				email: 'owner@workspace-b.example',
				password: 'correct horse battery staple',
				displayName: 'Bo Owner',
				organizationName: 'Workspace B',
				organizationSlug: 'workspace-b',
			})
		).principal.tenantId;
		const c = await provision(service, 'workspace-c', 'cli:ada');
		await service.signInExternalIdentity({
			provider: 'workforce',
			subject: 'workforce-subject-1',
			email: 'newcomer@example.com',
			workspace: {
				tenantId: c.tenantId,
				jitEnabled: true,
				allowedDomains: ['example.com'],
				jitRole: 'member',
			},
		});

		expect(
			(await service.listTenantMembers(c.tenantId)).map(
				(member) => member.email,
			),
		).toContain('newcomer@example.com');
		expect(await service.operatorWorkspace()).toMatchObject({
			workspace: a,
			source: 'first-workspace',
		});
		expect(await service.operatorStanding(b)).toBe('other');
		expect(await service.operatorStanding(c.tenantId)).toBe('other');
		expect(await operatorEvents(service, a.tenantId)).toHaveLength(1);
		expect(await operatorEvents(service, b)).toEqual([]);
		expect(await operatorEvents(service, c.tenantId)).toEqual([]);
	});
});

describe('AUTH-OPERATOR-SINGLE-WORKSPACE', () => {
	it('records the only workspace once when the platform, a worker and a CLI command open together', async () => {
		const { database, service } = await fixture();
		const a = await legacyWorkspace(database, 'workspace-a');
		const provider = barrierProvider(database.provider, writeBarrier(3));
		const platform = createAuthRuntime(runtimeOptions(provider));
		const worker = createModuleSettingsRuntime({ databases: provider });
		cleanups.push(
			() => platform.dispose(),
			() => worker.dispose(),
		);

		const [, , command] = await Promise.all([
			platform.service(),
			worker.settings.prime(a),
			readOperator(cliContext(provider)),
		]);

		const recorded = await service.operatorWorkspace();
		expect(recorded).toMatchObject({
			workspace: { tenantId: a },
			source: 'single-workspace',
		});
		expect(command.data).toMatchObject({
			operator: { workspace: { tenantId: a }, source: 'single-workspace' },
		});
		expect(await operatorEvents(service, a)).toEqual([
			expect.objectContaining({
				action: 'auth.operator.assigned',
				actorKind: 'service',
				actorLabel: SINGLE_WORKSPACE_RULE,
				metadata: { source: 'single-workspace' },
			}),
		]);

		const later = createAuthRuntime(runtimeOptions(database.provider));
		cleanups.push(() => later.dispose());
		await later.service();
		expect(await service.operatorWorkspace()).toEqual(recorded);
		expect(await operatorEvents(service, a)).toHaveLength(1);
	});

	it('records nothing on a database that holds two workspaces', async () => {
		const { database, service } = await fixture();
		const a = await legacyWorkspace(database, 'workspace-a');
		const b = await legacyWorkspace(database, 'workspace-b');

		const opened = createAuthRuntime(runtimeOptions(database.provider));
		cleanups.push(() => opened.dispose());
		await opened.service();

		expect(await service.operatorWorkspace()).toBeNull();
		expect(await service.operatorStanding(a)).toBe('none');
		expect(await service.operatorStanding(b)).toBe('none');
		expect(await operatorEvents(service, a)).toEqual([]);
		expect(await operatorEvents(service, b)).toEqual([]);
	});
});

describe('AUTH-OPERATOR-COMMAND', () => {
	it('reads the record, previews a change, applies it once and reports a repeat as no change', async () => {
		const { database, service } = await fixture();
		const a = await provision(service, 'workspace-a');
		const b = await provision(service, 'workspace-b');

		const read = await readOperator(cliContext(database.provider));
		expect(read.data).toEqual({
			operator: {
				workspace: a,
				source: 'first-workspace',
				recordedAt: expect.any(Number),
			},
			override: { variable: 'FD_OPERATOR_TENANT', set: false },
		});

		const preview = await setOperator(
			cliContext(database.provider, { arguments: [b.slug] }),
		);
		expect(preview.data).toMatchObject({
			applied: false,
			from: a,
			to: b,
			changed: true,
		});
		expect(await service.operatorStanding(a.tenantId)).toBe('own');
		expect(await operatorEvents(service, b.tenantId)).toEqual([]);

		const applied = await setOperator(
			cliContext(database.provider, { apply: true, arguments: [b.slug] }),
		);
		expect(applied.data).toMatchObject({
			applied: true,
			from: a,
			to: b,
			changed: true,
		});
		expect(await service.operatorStanding(a.tenantId)).toBe('other');
		expect(await service.operatorStanding(b.tenantId)).toBe('own');
		expect(await service.operatorWorkspace()).toMatchObject({
			workspace: b,
			source: 'command',
		});
		const released = (await operatorEvents(service, a.tenantId)).filter(
			(event) => event.action === 'auth.operator.released',
		);
		const assigned = await operatorEvents(service, b.tenantId);
		expect(released).toEqual([
			expect.objectContaining({
				actorLabel: 'cli:ada',
				subjectId: a.tenantId,
				metadata: { source: 'command' },
			}),
		]);
		expect(assigned).toEqual([
			expect.objectContaining({
				action: 'auth.operator.assigned',
				actorLabel: 'cli:ada',
				subjectId: b.tenantId,
				metadata: { source: 'command' },
			}),
		]);
		for (const [events, other] of [
			[released, b],
			[assigned, a],
		] as const) {
			const written = JSON.stringify(events);
			expect(written).not.toContain(other.tenantId);
			expect(written).not.toContain(other.slug);
			expect(written).not.toContain(other.name);
		}

		const repeat = await setOperator(
			cliContext(database.provider, { apply: true, arguments: [b.tenantId] }),
		);
		expect(repeat.data).toMatchObject({ applied: true, changed: false });
		expect(repeat.warnings).toContain(
			'"workspace-b" is already the operator workspace. Nothing was changed.',
		);
		expect(await operatorEvents(service, a.tenantId)).toHaveLength(2);
		expect(await operatorEvents(service, b.tenantId)).toHaveLength(1);
	});

	it('refuses a reference to no workspace and changes nothing', async () => {
		const { database, service } = await fixture();
		const a = await provision(service, 'workspace-a');

		await expect(
			setOperator(
				cliContext(database.provider, {
					apply: true,
					arguments: ['no-such-workspace'],
				}),
			),
		).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
		await expect(
			setOperator(cliContext(database.provider, { apply: true })),
		).rejects.toThrow('Name the workspace');

		expect(await service.operatorWorkspace()).toMatchObject({ workspace: a });
		expect(await operatorEvents(service, a.tenantId)).toHaveLength(1);
	});

	it('says whether FD_OPERATOR_TENANT in the shell names a workspace id', async () => {
		const { database, service } = await fixture();
		await provision(service, 'workspace-a');
		const b = await provision(service, 'workspace-b');
		const override = async (value: string) => {
			vi.stubEnv('FD_OPERATOR_TENANT', value);
			const result: CliExtensionResult = await readOperator(
				cliContext(database.provider),
			);
			return {
				override: (result.data as { override: unknown }).override,
				warnings: result.warnings,
			};
		};

		expect(await override(b.tenantId)).toEqual({
			override: {
				variable: 'FD_OPERATOR_TENANT',
				set: true,
				value: b.tenantId,
				workspace: b,
			},
			warnings: [
				'FD_OPERATOR_TENANT is set in this shell and names "workspace-b". Wherever the deployment sets it, it overrides this record.',
			],
		});
		for (const value of [b.slug, 'no-such-workspace']) {
			expect(await override(value)).toEqual({
				override: {
					variable: 'FD_OPERATOR_TENANT',
					set: true,
					value,
					workspace: null,
				},
				warnings: [
					'FD_OPERATOR_TENANT is set in this shell but names no workspace id. Wherever the deployment sets it so, no workspace is the operator, whatever this record says.',
				],
			});
		}
	});
});

describe('AUTH-OPERATOR-COMMAND-INTERRUPTED', () => {
	it('leaves no operator when the assign fails after the release, and the rerun records B', async () => {
		const { database, service } = await fixture();
		const a = await provision(service, 'workspace-a');
		const b = await provision(service, 'workspace-b');
		const apply = () =>
			setOperator(
				cliContext(database.provider, { apply: true, arguments: [b.slug] }),
			);

		await refusingAssignedEvents(database, () =>
			expect(apply()).rejects.toThrow(),
		);

		expect(await service.operatorWorkspace()).toBeNull();
		expect(await service.operatorStanding(a.tenantId)).toBe('none');
		expect(await service.operatorStanding(b.tenantId)).toBe('none');
		const read = await readOperator(cliContext(database.provider));
		expect(read.data).toMatchObject({ operator: null });
		expect(read.warnings).toContain(
			"No workspace is recorded as this deployment's operator, so where FD_OPERATOR_TENANT is unset no workspace changes platform-scoped settings. Record one with pnpm flowdular auth operator-set <id|slug> --apply.",
		);
		expect(await operatorEvents(service, b.tenantId)).toEqual([]);

		const rerun = await apply();
		expect(rerun.data).toMatchObject({ from: null, to: b, changed: true });
		expect(await service.operatorStanding(b.tenantId)).toBe('own');
		expect(await service.operatorStanding(a.tenantId)).toBe('other');
		expect(
			(await operatorEvents(service, a.tenantId))
				.map((event) => event.action)
				.sort(),
		).toEqual(['auth.operator.assigned', 'auth.operator.released']);
		expect(await operatorEvents(service, b.tenantId)).toHaveLength(1);
	});
});

describe('AUTH-OPERATOR-GREENFIELD', () => {
	it('records Operations Demo on every reset, with or without an earlier record', async () => {
		const databases = createPgliteTestProvider();
		cleanups.push(() => databases.dispose());
		const open = async () => {
			const runtime = await databases.acquire({
				namespace: 'auth.core',
				purpose: 'runtime',
			});
			const background = await databases.acquire({
				namespace: 'auth.core',
				purpose: 'background',
			});
			return serviceOver(
				new DatabaseAuthRepository({
					runtime: runtime.database,
					background: background.database,
				}),
			);
		};

		await seedGreenfield(databases);
		await (
			await open()
		).setOperator(GREENFIELD_TENANT_SLUGS.finance, 'cli:ada');
		await seedGreenfield(databases);

		const service = await open();
		const operations = (await service.findTenant(
			GREENFIELD_TENANT_SLUGS.operations,
		))!;
		const finance = (await service.findTenant(
			GREENFIELD_TENANT_SLUGS.finance,
		))!;
		expect(await service.operatorWorkspace()).toMatchObject({
			workspace: operations,
			source: 'first-workspace',
		});
		expect(await service.operatorStanding(finance.tenantId)).toBe('other');
		expect(await operatorEvents(service, operations.tenantId)).toEqual([
			expect.objectContaining({
				action: 'auth.operator.assigned',
				actorLabel: GREENFIELD_OPERATOR,
				metadata: { source: 'first-workspace' },
			}),
		]);
		expect(await operatorEvents(service, finance.tenantId)).toEqual([]);
	});
});

describe('AUTH-OPERATOR-ISOLATION', () => {
	const MIGRATOR = 'auth_operator_migrator';
	/* The roles a deployment runs with: a migrator that owns the tables and is
	   bound by their forced policies, and runtime and background roles that hold
	   neither SUPERUSER nor BYPASSRLS. */
	const BOOTSTRAP = `CREATE ROLE flowdular_runtime NOSUPERUSER NOBYPASSRLS;
CREATE ROLE flowdular_background NOSUPERUSER NOBYPASSRLS;
CREATE ROLE ${MIGRATOR} NOSUPERUSER NOBYPASSRLS;
GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATOR};
GRANT USAGE ON SCHEMA public TO flowdular_runtime, flowdular_background;
ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR} IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flowdular_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR} IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO flowdular_runtime;
`;

	it('binds the record to the workspace it names for every role', async () => {
		const cluster = createPgliteCluster({ bootstrap: BOOTSTRAP });
		const migrator = new PostgresDatabaseAdapter({
			pool: cluster.pool(MIGRATOR),
		});
		const runtime = new PostgresDatabaseAdapter({
			pool: cluster.pool('flowdular_runtime'),
			tenantRequired: true,
		});
		const background = new PostgresDatabaseAdapter({
			pool: cluster.pool('flowdular_background'),
		});
		cleanups.push(async () => {
			await Promise.allSettled([
				background.dispose(),
				runtime.dispose(),
				migrator.dispose(),
			]);
		});
		await migrateAuthDatabase(migrator);
		const service = serviceOver(
			new DatabaseAuthRepository({ runtime, background }),
		);
		const a = (await provision(service, 'workspace-a')).tenantId;
		const b = (await provision(service, 'workspace-b')).tenantId;
		const inTenant = (
			tenantId: string,
			statement: { text: string; parameters?: string[] },
		) =>
			runtime.transaction(
				async (transaction) => (await transaction.query(statement)).rows,
				{ tenantId, access: 'write' },
			);
		const privileges = {
			text: 'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
		};

		for (const rows of [
			(await migrator.query(privileges)).rows,
			(await background.query(privileges)).rows,
			await inTenant(b, privileges),
		]) {
			expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
		}

		expect(
			await inTenant(b, {
				text: 'SELECT tenant_id FROM auth_operator_workspace',
			}),
		).toEqual([]);
		await expect(
			inTenant(b, {
				text: `INSERT INTO auth_operator_workspace (tenant_id, source, recorded_at)
				       VALUES ($1, 'command', 1)`,
				parameters: [a],
			}),
		).rejects.toThrow(/row-level security/);
		expect(
			await inTenant(b, {
				text: 'DELETE FROM auth_operator_workspace WHERE tenant_id = $1 RETURNING tenant_id',
				parameters: [a],
			}),
		).toEqual([]);

		expect(
			(
				await background.query({
					text: 'SELECT tenant_id FROM auth_operator_workspace',
				})
			).rows,
		).toEqual([{ tenant_id: a }]);
		for (const text of [
			'SELECT source FROM auth_operator_workspace',
			'SELECT recorded_at FROM auth_operator_workspace',
			`INSERT INTO auth_operator_workspace (tenant_id, source, recorded_at) VALUES ('${b}', 'command', 1)`,
			`UPDATE auth_operator_workspace SET tenant_id = '${b}'`,
			'DELETE FROM auth_operator_workspace',
		]) {
			await expect(background.execute({ text }), text).rejects.toThrow(
				/permission denied/,
			);
		}

		expect(
			await inTenant(a, {
				text: 'SELECT tenant_id, source FROM auth_operator_workspace',
			}),
		).toEqual([{ tenant_id: a, source: 'first-workspace' }]);

		/* The migrator owns the table and still writes no row and reads none. */
		expect(
			(
				await migrator.query({
					text: 'SELECT tenant_id FROM auth_operator_workspace',
				})
			).rows,
		).toEqual([]);
		await expect(
			migrator.execute({
				text: `INSERT INTO auth_operator_workspace (tenant_id, source, recorded_at)
				       VALUES ($1, 'command', 1)`,
				parameters: [b],
			}),
		).rejects.toThrow(/row-level security/);
	});

	it('serves no HTTP route that reads or writes the record', async () => {
		const runtime = await testRuntime();
		cleanups.push(() => runtime.dispose());

		const paths = createAuthRoutes(runtime).map((route) => route.path);

		expect(paths.length).toBeGreaterThan(0);
		expect(paths.filter((path) => /operator/i.test(path))).toEqual([]);
	});
});
