import type { DatabaseHandle, DatabaseTransaction } from '@flowdular/database';
import {
	createModuleSettingsRuntime,
	defineModuleSettings,
	type ModuleSettingChange,
	type ModuleSettingsStore,
} from '@flowdular/kernel';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
	DatabaseAuthRepository,
	PLATFORM_SETTINGS_STORAGE_TENANT,
	settingsCursor,
} from '../src/services/database-repository.ts';
import {
	createAuthSettingsStore,
	sweepSettingsLog,
} from '../src/services/settings-store.ts';
import { createAuthModuleSettings } from '../src/settings.ts';
import {
	closeAuthTestDatabases,
	signUpOwner,
	testRuntime,
	type SignedIn,
	type TestRuntime,
} from './helpers.ts';
import type { AuthTestDatabase } from './support/database.ts';

const DAY = 24 * 60 * 60 * 1000;
const STALENESS = 5_000;

const DEMO = defineModuleSettings({
	moduleId: 'demo.core',
	settings: {
		pageSize: {
			type: 'number',
			defaultValue: 20,
			visibility: 'private',
			client: false,
			scope: 'tenant',
			min: 1,
			max: 500,
		},
		fastCheckout: {
			type: 'boolean',
			defaultValue: false,
			visibility: 'private',
			client: false,
			kind: 'flag',
			scope: 'tenant',
			label: 'Fast checkout',
			description: 'Skips the review step when the basket is small.',
		},
	},
});

const open = new Set<TestRuntime>();

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all([...open].map((runtime) => runtime.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

interface World {
	readonly runtime: TestRuntime;
	readonly database: AuthTestDatabase;
	readonly owner: SignedIn;
	readonly other: SignedIn;
}

/* Two workspaces with an owner each, so an event can be checked against the
   workspace it belongs to and against the one it must not reach. */
async function world(): Promise<World> {
	const runtime = await testRuntime();
	open.add(runtime);
	runtime.moduleSettings.declare(DEMO);
	const owner = await signUpOwner(runtime, 'owner@example.com', 'workspace-a');
	const other = await signUpOwner(runtime, 'other@example.com', 'workspace-b');
	return { runtime, database: runtime.database, owner, other };
}

interface WriteHooks {
	/** Inside a write transaction, after its work and before its commit. */
	beforeCommit?(tenantId: string): Promise<void> | void;
	/** After a write transaction committed; a throw stands for the process dying there. */
	afterCommit?(tenantId: string): void;
}

function hookedHandle(real: DatabaseHandle, hooks: WriteHooks): DatabaseHandle {
	const transaction = async <T>(
		operation: (transaction: DatabaseTransaction) => Promise<T>,
		options?: Parameters<DatabaseHandle['transaction']>[1],
	): Promise<T> => {
		const tenantId = options?.tenantId ?? '';
		const write = options?.access === 'write';
		const result = await real.transaction(async (inner) => {
			const value = await operation(inner);
			if (write) await hooks.beforeCommit?.(tenantId);
			return value;
		}, options);
		if (write) hooks.afterCommit?.(tenantId);
		return result;
	};
	return new Proxy(real, {
		get(target, property) {
			if (property === 'transaction') return transaction;
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

interface SettingsProcess {
	readonly settings: ReturnType<typeof createModuleSettingsRuntime>;
	readonly clock: { now: number };
	/** `tenant|module` of every load the process issued. */
	readonly loads: string[];
	readonly faults: { logReadFails: boolean };
}

/* Another process sharing the same database: its own kernel runtime, snapshot,
   cursor and clock over its own repository. */
function settingsProcess(
	database: AuthTestDatabase,
	handles: { readonly runtime?: DatabaseHandle } = {},
): SettingsProcess {
	const faults = { logReadFails: false };
	const background = new Proxy(database.background, {
		get(target, property) {
			const value = Reflect.get(target, property, target) as unknown;
			if (property === 'query') {
				return (...args: unknown[]) =>
					faults.logReadFails
						? Promise.reject(new Error('connection lost'))
						: (value as (...a: unknown[]) => unknown).apply(target, args);
			}
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	const repository = new DatabaseAuthRepository({
		runtime: handles.runtime ?? database.runtime,
		background,
	});
	const loads: string[] = [];
	const store = createAuthSettingsStore(() => Promise.resolve(repository));
	const counted: ModuleSettingsStore = {
		...store,
		load: (tenantId, moduleId) => {
			loads.push(`${tenantId}|${moduleId}`);
			return store.load(tenantId, moduleId);
		},
	};
	const clock = { now: 50_000_000 };
	const settings = createModuleSettingsRuntime(counted, {
		now: () => clock.now,
	});
	settings.declare(createAuthModuleSettings({ allowSignUp: true }));
	settings.declare(DEMO);
	return { settings, clock, loads, faults };
}

interface ChangeRow {
	readonly revision: number;
	readonly tenant_id: string;
	readonly module_id: string;
	readonly key: string;
	readonly cleared: number;
	readonly changed_at: number;
	readonly changed_by: string;
	readonly origin_tenant_id: string | null;
	readonly audit_pending: number;
}

async function changeRows(
	database: AuthTestDatabase,
	tenantId: string,
	key?: string,
): Promise<ChangeRow[]> {
	const result = await database.runtime.transaction(
		(transaction) =>
			transaction.query<Record<string, unknown>>({
				text: `SELECT * FROM module_settings_changes
				       WHERE ($1::text IS NULL OR key = $1) ORDER BY revision`,
				parameters: [key ?? null],
			}),
		{ tenantId, access: 'read' },
	);
	return result.rows.map((row) => ({
		revision: Number(row.revision),
		tenant_id: String(row.tenant_id),
		module_id: String(row.module_id),
		key: String(row.key),
		cleared: Number(row.cleared),
		changed_at: Number(row.changed_at),
		changed_by: String(row.changed_by),
		origin_tenant_id:
			row.origin_tenant_id === null ? null : String(row.origin_tenant_id),
		audit_pending: Number(row.audit_pending),
	}));
}

interface SettingsEvent {
	readonly action: string;
	readonly actorAccountId: string | null;
	readonly actorLabel: string;
	readonly subjectId: string;
	readonly metadata: unknown;
	readonly revision: number | null;
}

async function settingsEvents(
	database: AuthTestDatabase,
	tenantId: string,
): Promise<SettingsEvent[]> {
	const result = await database.runtime.transaction(
		(transaction) =>
			transaction.query<Record<string, unknown>>({
				text: `SELECT action, actor_account_id, actor_label, subject_id,
				              metadata_json, settings_revision
				       FROM auth_audit WHERE action LIKE 'settings.%' ORDER BY id`,
			}),
		{ tenantId, access: 'read' },
	);
	return result.rows.map((row) => ({
		action: String(row.action),
		actorAccountId:
			row.actor_account_id === null ? null : String(row.actor_account_id),
		actorLabel: String(row.actor_label),
		subjectId: String(row.subject_id),
		metadata: JSON.parse(String(row.metadata_json)) as unknown,
		revision:
			row.settings_revision === null ? null : Number(row.settings_revision),
	}));
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

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('AUTH-SETTINGS-STORE', () => {
	it('commits the value, one change row without the value and one event together', async () => {
		const { runtime, database, owner } = await world();
		const heard: ModuleSettingChange[] = [];
		runtime.moduleSettings.onChange((change) => heard.push(change));
		await runtime.moduleSettings.prime(owner.tenantId);

		const before = Date.now();
		await runtime.moduleSettings.set(
			owner.tenantId,
			'demo.core',
			'pageSize',
			77,
			owner.accountId,
		);
		const after = Date.now();

		expect(
			runtime.moduleSettings.get(owner.tenantId, 'demo.core', 'pageSize'),
		).toBe(77);
		const [row, ...rest] = await changeRows(
			database,
			owner.tenantId,
			'pageSize',
		);
		expect(rest).toEqual([]);
		expect(row).toMatchObject({
			tenant_id: owner.tenantId,
			module_id: 'demo.core',
			key: 'pageSize',
			cleared: 0,
			changed_by: owner.accountId,
			origin_tenant_id: owner.tenantId,
			audit_pending: 0,
		});
		expect(row!.revision).toBe(heard[0]?.revision);
		expect(row!.changed_at).toBeGreaterThanOrEqual(before - 2_000);
		expect(row!.changed_at).toBeLessThanOrEqual(after + 2_000);
		expect(Object.values(row!)).not.toContain(77);
		expect(await settingsEvents(database, owner.tenantId)).toEqual([
			{
				action: 'settings.updated',
				actorAccountId: owner.accountId,
				actorLabel: 'owner@example.com',
				subjectId: 'demo.core.pageSize',
				metadata: { cleared: false },
				revision: row!.revision,
			},
		]);

		await runtime.moduleSettings.set(
			owner.tenantId,
			'demo.core',
			'pageSize',
			null,
			owner.accountId,
		);

		const rows = await changeRows(database, owner.tenantId, 'pageSize');
		expect(rows.map((change) => change.cleared)).toEqual([0, 1]);
		expect(
			(await settingsEvents(database, owner.tenantId)).map((event) => [
				event.metadata,
				event.revision,
			]),
		).toEqual([
			[{ cleared: false }, rows[0]!.revision],
			[{ cleared: true }, rows[1]!.revision],
		]);
	});

	it('stores a platform value once and audits it in the workspace it was saved from', async () => {
		const { runtime, database, owner, other } = await world();

		await runtime.moduleSettings.set(
			owner.tenantId,
			'auth.core',
			'allowSignUp',
			false,
			owner.accountId,
		);

		expect(await database.repository.loadSettings('', 'auth.core')).toEqual({
			allowSignUp: false,
		});
		const [row] = await changeRows(
			database,
			PLATFORM_SETTINGS_STORAGE_TENANT,
			'allowSignUp',
		);
		expect(row).toMatchObject({
			module_id: 'auth.core',
			cleared: 0,
			changed_by: owner.accountId,
			origin_tenant_id: owner.tenantId,
			audit_pending: 0,
		});
		expect(await settingsEvents(database, owner.tenantId)).toEqual([
			{
				action: 'settings.updated',
				actorAccountId: owner.accountId,
				actorLabel: 'owner@example.com',
				subjectId: 'auth.core.allowSignUp',
				metadata: { cleared: false },
				revision: row!.revision,
			},
		]);
		expect(await settingsEvents(database, other.tenantId)).toEqual([]);
	});
});

describe('AUTH-SETTINGS-FLAG-AUDIT', () => {
	it('records the values its own transaction read, and refuses the save when the event cannot be written', async () => {
		const { runtime, database, owner } = await world();
		const elsewhere = settingsProcess(database);
		await runtime.moduleSettings.prime(owner.tenantId);

		await runtime.moduleSettings.set(
			owner.tenantId,
			'demo.core',
			'fastCheckout',
			true,
			owner.accountId,
		);
		/* Another process turns it off while this one still holds it on, so only
		   a read inside the reset's own transaction knows what it replaced. */
		await elsewhere.settings.set(
			owner.tenantId,
			'demo.core',
			'fastCheckout',
			false,
			owner.accountId,
		);
		await runtime.moduleSettings.set(
			owner.tenantId,
			'demo.core',
			'fastCheckout',
			null,
			owner.accountId,
		);

		const events = await settingsEvents(database, owner.tenantId);
		expect(events.map((event) => event.action)).toEqual([
			'settings.flag.changed',
			'settings.flag.changed',
			'settings.flag.changed',
		]);
		expect(events.map((event) => event.metadata)).toEqual([
			{ cleared: false, previous: false, next: true },
			{ cleared: false, previous: true, next: false },
			{ cleared: true, previous: false, next: false },
		]);
		expect(events[0]).toMatchObject({
			actorAccountId: owner.accountId,
			actorLabel: 'owner@example.com',
			subjectId: 'demo.core.fastCheckout',
		});

		const rowsBefore = await changeRows(
			database,
			owner.tenantId,
			'fastCheckout',
		);
		await withMigrator(database, (migrator) =>
			migrator.execute({
				text: `ALTER TABLE auth_audit ADD CONSTRAINT settings_log_test_refusal
				       CHECK (subject_id <> 'demo.core.fastCheckout') NOT VALID`,
			}),
		);
		try {
			await expect(
				runtime.moduleSettings.set(
					owner.tenantId,
					'demo.core',
					'fastCheckout',
					true,
					owner.accountId,
				),
			).rejects.toThrow();
		} finally {
			await withMigrator(database, (migrator) =>
				migrator.execute({
					text: 'ALTER TABLE auth_audit DROP CONSTRAINT settings_log_test_refusal',
				}),
			);
		}

		expect(
			await database.repository.loadSettings(owner.tenantId, 'demo.core'),
		).toEqual({});
		expect(await changeRows(database, owner.tenantId, 'fastCheckout')).toEqual(
			rowsBefore,
		);
		expect(await settingsEvents(database, owner.tenantId)).toHaveLength(3);
	});
});

describe('AUTH-SETTINGS-CRASH-AFTER-COMMIT', () => {
	it('leaves the value, its change row and its event once each when the process dies at the commit', async () => {
		const { database, owner } = await world();
		const crash = { armed: false };
		const dying = settingsProcess(database, {
			runtime: hookedHandle(database.runtime, {
				afterCommit: () => {
					if (crash.armed) throw new Error('process killed');
				},
			}),
		});
		const reader = settingsProcess(database);
		await dying.settings.prime(owner.tenantId);
		await reader.settings.prime(owner.tenantId);
		const held = await database.repository.newestSettingsRevision();
		const heard: ModuleSettingChange[] = [];
		dying.settings.onChange((change) => heard.push(change));

		crash.armed = true;
		await expect(
			dying.settings.set(
				owner.tenantId,
				'demo.core',
				'pageSize',
				64,
				owner.accountId,
			),
		).rejects.toThrow('process killed');
		await expect(
			dying.settings.set(
				owner.tenantId,
				'demo.core',
				'fastCheckout',
				true,
				owner.accountId,
			),
		).rejects.toThrow('process killed');

		expect(heard).toEqual([]);
		expect(
			await database.repository.loadSettings(owner.tenantId, 'demo.core'),
		).toEqual({ pageSize: 64, fastCheckout: true });
		const rows = await changeRows(database, owner.tenantId);
		expect(rows.map((row) => row.key)).toEqual(['pageSize', 'fastCheckout']);
		expect(
			(await settingsEvents(database, owner.tenantId)).map((event) => [
				event.action,
				event.revision,
			]),
		).toEqual([
			['settings.updated', rows[0]!.revision],
			['settings.flag.changed', rows[1]!.revision],
		]);

		const page = await reader.settings.changesAfter({
			after: held.cursor,
			limit: 500,
		});
		expect(page).toMatchObject({
			expired: false,
			changes: [
				{ revision: rows[0]!.revision, key: 'pageSize', cleared: false },
				{ revision: rows[1]!.revision, key: 'fastCheckout', cleared: false },
			],
		});
		reader.clock.now += STALENESS + 1;
		await reader.settings.prime(owner.tenantId);
		expect(
			reader.settings.get(owner.tenantId, 'demo.core', 'fastCheckout'),
		).toBe(true);
	});
});

describe('AUTH-SETTINGS-PLATFORM-AUDIT', () => {
	it('lands the owed workspace event once through the sweep after the saving process died', async () => {
		const { database, owner, other } = await world();
		const dying = settingsProcess(database, {
			runtime: hookedHandle(database.runtime, {
				afterCommit: (tenantId) => {
					if (tenantId === PLATFORM_SETTINGS_STORAGE_TENANT) {
						throw new Error('process killed');
					}
				},
			}),
		});
		await dying.settings.prime(owner.tenantId);

		await expect(
			dying.settings.set(
				owner.tenantId,
				'auth.core',
				'allowSignUp',
				false,
				owner.accountId,
			),
		).rejects.toThrow('process killed');

		const [marked] = await changeRows(
			database,
			PLATFORM_SETTINGS_STORAGE_TENANT,
			'allowSignUp',
		);
		expect(marked).toMatchObject({
			audit_pending: 1,
			origin_tenant_id: owner.tenantId,
		});
		expect(await settingsEvents(database, owner.tenantId)).toEqual([]);

		await Promise.all([
			sweepSettingsLog(database.repository),
			sweepSettingsLog(database.repository),
		]);
		await sweepSettingsLog(database.repository);

		expect(await settingsEvents(database, owner.tenantId)).toEqual([
			{
				action: 'settings.updated',
				actorAccountId: owner.accountId,
				actorLabel: 'owner@example.com',
				subjectId: 'auth.core.allowSignUp',
				metadata: { cleared: false },
				revision: marked!.revision,
			},
		]);
		expect(
			await changeRows(database, PLATFORM_SETTINGS_STORAGE_TENANT),
		).toMatchObject([{ revision: marked!.revision, audit_pending: 0 }]);
		expect(await settingsEvents(database, other.tenantId)).toEqual([]);
		expect(
			await settingsEvents(database, PLATFORM_SETTINGS_STORAGE_TENANT),
		).toEqual([]);
	});

	it('resolves a committed save whose event write failed and leaves the event to the sweep', async () => {
		const { database, owner } = await world();
		const refusing = settingsProcess(database, {
			runtime: hookedHandle(database.runtime, {
				beforeCommit: (tenantId) => {
					if (tenantId === owner.tenantId) {
						throw new Error('insert failed: bound value "owner@example.com"');
					}
				},
			}),
		});
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		await refusing.settings.prime(owner.tenantId);

		await refusing.settings.set(
			owner.tenantId,
			'auth.core',
			'allowSignUp',
			false,
			owner.accountId,
		);

		expect(refusing.settings.get('', 'auth.core', 'allowSignUp')).toBe(false);
		expect(await settingsEvents(database, owner.tenantId)).toEqual([]);
		expect(JSON.stringify(logged.mock.calls)).not.toContain('insert failed');
		expect(JSON.stringify(logged.mock.calls)).not.toContain(
			'owner@example.com',
		);

		await sweepSettingsLog(database.repository);

		expect(
			(await settingsEvents(database, owner.tenantId)).map(
				(event) => event.subjectId,
			),
		).toEqual(['auth.core.allowSignUp']);
	});
});

describe('AUTH-SETTINGS-REVALIDATE', () => {
	it('serves another process the new values within the bound, reloading only the pairs that changed', async () => {
		const { runtime: a, database, owner } = await world();
		const b = settingsProcess(database);
		await a.moduleSettings.prime(owner.tenantId);
		await b.settings.prime(owner.tenantId);
		await b.settings.prime('');
		b.loads.length = 0;

		await a.moduleSettings.set(
			owner.tenantId,
			'demo.core',
			'pageSize',
			90,
			owner.accountId,
		);
		await a.moduleSettings.set(
			owner.tenantId,
			'auth.core',
			'allowSignUp',
			false,
			owner.accountId,
		);
		expect(a.moduleSettings.get(owner.tenantId, 'demo.core', 'pageSize')).toBe(
			90,
		);
		expect(a.moduleSettings.get('', 'auth.core', 'allowSignUp')).toBe(false);

		b.clock.now += STALENESS - 1;
		await b.settings.prime(owner.tenantId);
		expect(b.settings.get(owner.tenantId, 'demo.core', 'pageSize')).toBe(20);
		expect(b.settings.get('', 'auth.core', 'allowSignUp')).toBe(true);

		b.clock.now += 2;
		await b.settings.prime(owner.tenantId);
		expect(b.settings.get(owner.tenantId, 'demo.core', 'pageSize')).toBe(90);
		expect(b.settings.get('', 'auth.core', 'allowSignUp')).toBe(false);
		expect(b.loads.sort()).toEqual(
			[`${owner.tenantId}|demo.core`, '|auth.core'].sort(),
		);
	});

	it('reflects a named revision at once and fails a prime whose log read fails', async () => {
		const { runtime: a, database, owner } = await world();
		const b = settingsProcess(database);
		await b.settings.prime(owner.tenantId);
		const heard: ModuleSettingChange[] = [];
		a.moduleSettings.onChange((change) => heard.push(change));

		await a.moduleSettings.set(
			owner.tenantId,
			'demo.core',
			'pageSize',
			91,
			owner.accountId,
		);
		await b.settings.prime(owner.tenantId, { revision: heard[0]!.revision! });
		expect(b.settings.get(owner.tenantId, 'demo.core', 'pageSize')).toBe(91);

		await a.moduleSettings.set(
			owner.tenantId,
			'demo.core',
			'pageSize',
			92,
			owner.accountId,
		);
		b.faults.logReadFails = true;
		b.clock.now += STALENESS + 1;
		await expect(b.settings.prime(owner.tenantId)).rejects.toThrow(
			'connection lost',
		);
		await expect(
			b.settings.prime(owner.tenantId, { revision: heard[1]!.revision! }),
		).rejects.toThrow('connection lost');

		b.faults.logReadFails = false;
		await b.settings.prime(owner.tenantId);
		expect(b.settings.get(owner.tenantId, 'demo.core', 'pageSize')).toBe(92);
	});
});

describe('AUTH-SETTINGS-LISTENER-LOCAL', () => {
	it('announces a change in the saving process only, once and with its revision', async () => {
		const { runtime: a, database, owner } = await world();
		const b = settingsProcess(database);
		await a.moduleSettings.prime(owner.tenantId);
		await b.settings.prime(owner.tenantId);
		const heardA: ModuleSettingChange[] = [];
		const heardB: ModuleSettingChange[] = [];
		a.moduleSettings.onChange((change) => heardA.push(change));
		b.settings.onChange((change) => heardB.push(change));

		await a.moduleSettings.set(
			owner.tenantId,
			'demo.core',
			'pageSize',
			33,
			owner.accountId,
		);
		b.clock.now += STALENESS + 1;
		await b.settings.prime(owner.tenantId);

		const [row] = await changeRows(database, owner.tenantId, 'pageSize');
		expect(heardA).toEqual([
			expect.objectContaining({
				tenantId: owner.tenantId,
				moduleId: 'demo.core',
				key: 'pageSize',
				revision: row!.revision,
			}),
		]);
		expect(b.settings.get(owner.tenantId, 'demo.core', 'pageSize')).toBe(33);
		expect(heardB).toEqual([]);
		expect(
			(await settingsEvents(database, owner.tenantId)).map(
				(event) => event.revision,
			),
		).toEqual([row!.revision]);
	});
});

describe('AUTH-SETTINGS-LOG-BACKGROUND', () => {
	it('reads which setting changed and when across tenants, and nothing else', async () => {
		const { database, owner, other } = await world();
		const writer = settingsProcess(database);
		const secret = 'smtp://relay-user:s3cret-pass@relay.example:587';
		await writer.settings.set(
			owner.tenantId,
			'auth.core',
			'mailSmtpUrl',
			secret,
			owner.accountId,
		);
		await writer.settings.set(
			owner.tenantId,
			'demo.core',
			'pageSize',
			55,
			owner.accountId,
		);
		await writer.settings.set(
			other.tenantId,
			'demo.core',
			'pageSize',
			56,
			other.accountId,
		);

		const visible = await database.background.query<Record<string, unknown>>({
			text: `SELECT revision, tenant_id, module_id, key, cleared, changed_at
			       FROM module_settings_changes ORDER BY revision`,
		});
		expect(
			visible.rows.map((row) => [row.tenant_id, row.module_id, row.key]),
		).toEqual([
			[PLATFORM_SETTINGS_STORAGE_TENANT, 'auth.core', 'mailSmtpUrl'],
			[owner.tenantId, 'demo.core', 'pageSize'],
			[other.tenantId, 'demo.core', 'pageSize'],
		]);
		for (const column of [
			'changed_by',
			'origin_tenant_id',
			'audit_pending',
			'*',
		]) {
			await expect(
				database.background.query({
					text: `SELECT ${column} FROM module_settings_changes`,
				}),
			).rejects.toThrow(/permission denied/);
		}
		for (const text of [
			`INSERT INTO module_settings_changes
			   (tenant_id, module_id, key, cleared, changed_at, changed_by)
			 VALUES ('${owner.tenantId}', 'demo.core', 'pageSize', 0, 1, 'x')`,
			'UPDATE module_settings_changes SET cleared = 1',
			'DELETE FROM module_settings_changes',
		]) {
			await expect(database.background.execute({ text })).rejects.toThrow(
				/permission denied/,
			);
		}

		const columns = await withMigrator(database, (migrator) =>
			migrator.query<{ column_name: string }>({
				text: `SELECT column_name FROM information_schema.columns
				       WHERE table_schema = current_schema()
				         AND table_name = 'module_settings_changes'
				       ORDER BY ordinal_position`,
			}),
		);
		expect(columns.rows.map((row) => row.column_name)).toEqual([
			'revision',
			'tenant_id',
			'module_id',
			'key',
			'cleared',
			'changed_at',
			'changed_by',
			'origin_tenant_id',
			'audit_pending',
		]);
		const every = [
			...(await changeRows(database, PLATFORM_SETTINGS_STORAGE_TENANT)),
			...(await changeRows(database, owner.tenantId)),
			...(await changeRows(database, other.tenantId)),
		];
		expect(every).toHaveLength(3);
		expect(JSON.stringify(every)).not.toContain('s3cret');
		expect(every.flatMap((row) => Object.values(row))).not.toContain(55);
	});
});

describe('AUTH-SETTINGS-LOG-TENANT', () => {
	it('keeps a workspace to its own rows and refuses an append naming another', async () => {
		const { database, owner, other } = await world();
		const writer = settingsProcess(database);
		await writer.settings.set(
			owner.tenantId,
			'demo.core',
			'pageSize',
			41,
			owner.accountId,
		);
		await writer.settings.set(
			other.tenantId,
			'demo.core',
			'pageSize',
			42,
			other.accountId,
		);
		const othersBefore = await changeRows(database, other.tenantId);

		const seen = await changeRows(database, owner.tenantId);
		expect(seen.map((row) => row.tenant_id)).toEqual([owner.tenantId]);
		await expect(
			database.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO module_settings_changes
						       (tenant_id, module_id, key, cleared, changed_at, changed_by)
						       VALUES ($1, 'demo.core', 'pageSize', 1, 1, $2)`,
						parameters: [other.tenantId, owner.accountId],
					}),
				{ tenantId: owner.tenantId, access: 'write' },
			),
		).rejects.toThrow(/row-level security/);

		expect(await changeRows(database, other.tenantId)).toEqual(othersBefore);
	});
});

describe('AUTH-SETTINGS-LOG-RETENTION', () => {
	it('prunes only superseded rows past 30 days, a batch per tenant transaction, and expires a cursor past 29', async () => {
		const { database, owner, other } = await world();
		const now = Date.now();
		const seed = async (
			tenantId: string,
			rows: readonly (readonly [string, string, number, number?])[],
		): Promise<void> =>
			withMigrator(database, (migrator) =>
				migrator.transaction(
					async (transaction) => {
						for (const [moduleId, key, age, pending] of rows) {
							await transaction.execute({
								text: `INSERT INTO module_settings_changes
								       (tenant_id, module_id, key, cleared, changed_at,
								        changed_by, origin_tenant_id, audit_pending)
								       VALUES ($1, $2, $3, 0, $4, 'seed', $5, $6)`,
								parameters: [
									tenantId,
									moduleId,
									key,
									now - age,
									pending ? owner.tenantId : null,
									pending ?? 0,
								],
							});
						}
					},
					{ tenantId, access: 'write' },
				),
			);
		await seed(owner.tenantId, [
			['demo.core', 'only', 40 * DAY],
			['demo.core', 'pageSize', 40 * DAY],
			['demo.core', 'pageSize', 39 * DAY],
			['demo.core', 'pageSize', 38 * DAY],
			['demo.core', 'pageSize', 1 * DAY],
			['demo.core', 'recent', 3 * DAY],
			['demo.core', 'recent', 2 * DAY],
		]);
		await seed(other.tenantId, [
			['demo.core', 'pageSize', 40 * DAY],
			['demo.core', 'pageSize', 39 * DAY],
			['demo.core', 'pageSize', 35 * DAY],
		]);
		await seed(PLATFORM_SETTINGS_STORAGE_TENANT, [
			['auth.core', 'allowSignUp', 45 * DAY],
			['auth.core', 'allowSignUp', 31 * DAY, 1],
			['auth.core', 'allowSignUp', 2 * DAY],
		]);
		const keptBefore = await Promise.all(
			[owner.tenantId, other.tenantId, PLATFORM_SETTINGS_STORAGE_TENANT].map(
				(tenantId) => changeRows(database, tenantId),
			),
		);

		/* Three superseded old rows in one workspace, two in the other and one
		   on the platform: a pass removes at most a batch of two in each. */
		const passes: number[] = [];
		for (let pass = 0; pass < 5; pass += 1) {
			passes.push(await database.repository.deleteSupersededSettingsChanges(2));
		}

		expect(passes).toEqual([5, 1, 0, 0, 0]);
		const ages = async (tenantId: string) =>
			(await changeRows(database, tenantId)).map((row) => [
				row.key,
				Math.round((now - row.changed_at) / DAY),
			]);
		expect(await ages(owner.tenantId)).toEqual([
			['only', 40],
			['pageSize', 1],
			['recent', 3],
			['recent', 2],
		]);
		expect(await ages(other.tenantId)).toEqual([['pageSize', 35]]);
		expect(await ages(PLATFORM_SETTINGS_STORAGE_TENANT)).toEqual([
			['allowSignUp', 31],
			['allowSignUp', 2],
		]);
		expect(keptBefore.flat()).toHaveLength(13);

		const reader = settingsProcess(database);
		await expect(
			reader.settings.changesAfter({
				after: settingsCursor(0, now - 29 * DAY - 60_000),
				limit: 500,
			}),
		).resolves.toEqual({ expired: true });
		await expect(
			reader.settings.changesAfter({
				after: settingsCursor(0, now - 28 * DAY),
				limit: 500,
			}),
		).resolves.toMatchObject({ expired: false });
		const fromStart = await reader.settings.changesAfter({
			after: null,
			limit: 500,
		});
		if (fromStart.expired) throw new Error('A read from the start expired.');
		const newest = new Map<string, number>();
		for (const change of fromStart.changes) {
			newest.set(
				`${change.tenantId}|${change.moduleId}|${change.key}`,
				Math.round((now - change.changedAt) / DAY),
			);
		}
		expect(Object.fromEntries(newest)).toEqual({
			[`${owner.tenantId}|demo.core|only`]: 40,
			[`${owner.tenantId}|demo.core|pageSize`]: 1,
			[`${owner.tenantId}|demo.core|recent`]: 2,
			[`${other.tenantId}|demo.core|pageSize`]: 35,
			'|auth.core|allowSignUp': 2,
		});
	});
});

describe.skipIf(process.env.FD_TEST_DATABASE_ADAPTER !== 'postgresql')(
	'AUTH-SETTINGS-COMMIT-ORDER',
	() => {
		it('never shows a later revision before an earlier one commits', async () => {
			const { database, owner, other } = await world();
			const gates = new Map<
				string,
				{
					arrived: ReturnType<typeof deferred>;
					release: ReturnType<typeof deferred>;
				}
			>();
			const gate = (tenantId: string) => {
				const opened = { arrived: deferred(), release: deferred() };
				gates.set(tenantId, opened);
				return opened;
			};
			const writer = settingsProcess(database, {
				runtime: hookedHandle(database.runtime, {
					beforeCommit: async (tenantId) => {
						const held = gates.get(tenantId);
						if (!held) return;
						gates.delete(tenantId);
						held.arrived.resolve();
						await held.release.promise;
					},
				}),
			});
			const reader = settingsProcess(database);
			const start = await reader.settings.changesAfter({
				after: null,
				limit: 500,
			});
			if (start.expired) throw new Error('A read from the start expired.');

			const first = gate(owner.tenantId);
			const saveA = writer.settings.set(
				owner.tenantId,
				'demo.core',
				'pageSize',
				31,
				owner.accountId,
			);
			await first.arrived.promise;
			const saveB = writer.settings.set(
				other.tenantId,
				'demo.core',
				'pageSize',
				32,
				other.accountId,
			);
			await new Promise((done) => setTimeout(done, 300));
			const during = await reader.settings.changesAfter({
				after: start.cursor,
				limit: 500,
			});
			expect(during).toMatchObject({ expired: false, changes: [] });
			first.release.resolve();
			await Promise.all([saveA, saveB]);
			if (during.expired) throw new Error('A fresh cursor expired.');
			const settled = await reader.settings.changesAfter({
				after: during.cursor,
				limit: 500,
			});
			if (settled.expired) throw new Error('A fresh cursor expired.');
			expect(settled.changes.map((change) => change.tenantId)).toEqual([
				owner.tenantId,
				other.tenantId,
			]);

			const third = gate(owner.tenantId);
			const fourth = gate(other.tenantId);
			const saveC = writer.settings.set(
				owner.tenantId,
				'demo.core',
				'pageSize',
				41,
				owner.accountId,
			);
			await third.arrived.promise;
			const saveD = writer.settings.set(
				other.tenantId,
				'demo.core',
				'pageSize',
				42,
				other.accountId,
			);
			third.release.resolve();
			await saveC;
			await fourth.arrived.promise;
			const between = await reader.settings.changesAfter({
				after: settled.cursor,
				limit: 500,
			});
			if (between.expired) throw new Error('A fresh cursor expired.');
			expect(between.changes.map((change) => change.tenantId)).toEqual([
				owner.tenantId,
			]);
			fourth.release.resolve();
			await saveD;
			const next = await reader.settings.changesAfter({
				after: between.cursor,
				limit: 500,
			});
			expect(next).toMatchObject({
				expired: false,
				changes: [{ tenantId: other.tenantId, key: 'pageSize' }],
			});
		});
	},
);
