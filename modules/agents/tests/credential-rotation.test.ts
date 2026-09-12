import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseAdapterLease,
	type DatabaseHandle,
	type DatabaseOperationOptions,
	type DatabaseProvider,
	type DatabaseRow,
	type DatabaseSession,
	type DatabaseStatement,
	type DatabaseTransaction,
} from '@flowdular/database';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import cliExtension from '../src/cli/index.ts';
import type {
	AgentProviderKind,
	AgentProviderModelConfiguration,
} from '../src/domain/types.ts';
import { rotateProviderCredentials } from '../src/services/credential-rotation.ts';
import {
	AesGcmCredentialVault,
	credentialContext,
	credentialVaultFromEnvironment,
} from '../src/services/credential-vault.ts';
import { AgentProviderService } from '../src/services/provider-service.ts';
import {
	openAgentsTestDatabase,
	type AgentsTestDatabase,
} from './support/database.ts';

const KEY_A = Buffer.alloc(32, 0xa1);
const KEY_B = Buffer.alloc(32, 0xb2);
const KEY_C = Buffer.alloc(32, 0xc3);
const CREDENTIAL = 'sk-rotation-credential';

const models: readonly AgentProviderModelConfiguration[] = [
	{
		id: 'gpt-4o-mini',
		label: 'GPT-4o mini',
		enabled: true,
		supportsTools: true,
		supportsStreaming: true,
		supportsWebSearch: false,
	},
];

const REQUIREMENTS = {
	dialectIds: [DATABASE_DIALECT_IDS.postgresql],
	capabilities: [
		DATABASE_CAPABILITY_IDS.ROW_LEVEL_SECURITY,
		DATABASE_CAPABILITY_IDS.TENANT_CONTEXT,
		DATABASE_CAPABILITY_IDS.TRANSACTIONS,
	],
};

let database: AgentsTestDatabase;
let runtime: DatabaseAdapterLease;
let background: DatabaseAdapterLease;

beforeAll(async () => {
	database = await openAgentsTestDatabase();
	runtime = await database.databases.acquire({
		namespace: 'agents.core',
		purpose: 'runtime',
		requirements: REQUIREMENTS,
	});
	background = await database.databases.acquire({
		namespace: 'agents.core',
		purpose: 'background',
		requirements: REQUIREMENTS,
	});
});

beforeEach(async () => {
	await database.truncate();
});

afterAll(async () => {
	await runtime?.release();
	await background?.release();
	await database?.dispose();
});

function vault(current: Buffer, previous: readonly Buffer[] = []) {
	return new AesGcmCredentialVault(current, previous);
}

async function connect(tenantId: string, key: string, current: Buffer) {
	const service = new AgentProviderService(
		database.providers,
		vault(current),
		database.repository,
		{
			hostAllowlist: new Set<string>(),
			readinessTtlMs: 60_000,
			readinessTimeoutMs: 1_000,
			now: () => 1_700_000_000_000,
		},
	);
	return service.create(tenantId, 'owner-rotation', {
		key,
		name: `Connection ${key}`,
		kind: 'openai',
		credential: CREDENTIAL,
		models,
	});
}

function rotate(current: Buffer, previous: readonly Buffer[], apply: boolean) {
	return rotateProviderCredentials({
		runtime: runtime.database,
		background: background.database,
		vault: vault(current, previous),
		apply,
	});
}

async function storedCredential(tenantId: string, id: string) {
	const stored = await database.providers.get(tenantId, id);
	if (!stored) throw new Error(`No stored connection ${id}.`);
	return stored;
}

interface StoredEnvelope extends DatabaseRow {
	id: string;
	kind: AgentProviderKind;
	credential_ciphertext: string;
}

function forwardQuery(session: DatabaseSession) {
	return <Row extends DatabaseRow = DatabaseRow>(
		statement: DatabaseStatement,
		options?: DatabaseOperationOptions,
	) => session.query<Row>(statement, options);
}

/* The optimistic update refuses only a row whose envelope changed after the
   batch read it. This handle re-seals the first row of the batch under the old
   key while that transaction is still open, which is what an application write
   landing between the read and the update looks like to the rotation. */
function handleRewritingFirstRow(
	handle: DatabaseHandle,
	tenantId: string,
): DatabaseHandle {
	let rewritten = false;
	const session = (transaction: DatabaseTransaction): DatabaseTransaction => ({
		adapterId: transaction.adapterId,
		dialectId: transaction.dialectId,
		capabilities: transaction.capabilities,
		schema: transaction.schema,
		acquireMigrationLock: (namespace) =>
			transaction.acquireMigrationLock(namespace),
		execute: (statement, options) => transaction.execute(statement, options),
		executeScript: (script, options) =>
			transaction.executeScript(script, options),
		query: async <Row extends DatabaseRow = DatabaseRow>(
			statement: DatabaseStatement,
			options?: DatabaseOperationOptions,
		) => {
			const result = await transaction.query<Row>(statement, options);
			const row = result.rows[0] as StoredEnvelope | undefined;
			if (!rewritten && row?.credential_ciphertext) {
				rewritten = true;
				const sealed = vault(KEY_A).encrypt(
					CREDENTIAL,
					credentialContext({ tenantId, id: row.id, kind: row.kind }),
				);
				await transaction.execute({
					text: `UPDATE agent_provider_connections
					       SET credential_key_id = $1, credential_iv = $2,
					           credential_tag = $3, credential_ciphertext = $4
					       WHERE tenant_id = $5 AND id = $6`,
					parameters: [
						sealed.keyId,
						sealed.iv,
						sealed.tag,
						sealed.ciphertext,
						tenantId,
						row.id,
					],
				});
			}
			return result;
		},
	});
	return {
		adapterId: handle.adapterId,
		dialectId: handle.dialectId,
		capabilities: handle.capabilities,
		schema: handle.schema,
		query: forwardQuery(handle),
		execute: (statement, options) => handle.execute(statement, options),
		executeScript: (script, options) => handle.executeScript(script, options),
		transaction: (operation, options) =>
			handle.transaction(
				(transaction) => operation(session(transaction)),
				options,
			),
	};
}

/* Only the runtime lease writes rows, so the command reaches the seam while the
   inventory and the migration it takes stay untouched. */
function databasesRewritingFirstRow(tenantId: string): DatabaseProvider {
	return {
		acquire: async (request) => {
			const lease = await database.databases.acquire(request);
			if (request.purpose !== 'runtime') return lease;
			return {
				database: handleRewritingFirstRow(lease.database, tenantId),
				release: () => lease.release(),
			};
		},
		dispose: () => database.databases.dispose(),
	};
}

describe('the credential vault across a rotation', () => {
	it('opens an envelope written before the rotation and writes the new key', () => {
		const context = credentialContext({
			tenantId: 'tenant-a',
			id: 'provider-1',
			kind: 'openai',
		});
		const sealed = vault(KEY_A).encrypt(CREDENTIAL, context);
		const rotated = vault(KEY_B, [KEY_A]);

		expect(rotated.decrypt(sealed, context)).toBe(CREDENTIAL);
		expect(rotated.encrypt(CREDENTIAL, context).keyId).toBe(vault(KEY_B).keyId);
	});

	it('refuses an envelope whose key is in neither slot, with a stable code', () => {
		const context = credentialContext({
			tenantId: 'tenant-a',
			id: 'provider-1',
			kind: 'openai',
		});
		const sealed = vault(KEY_A).encrypt(CREDENTIAL, context);

		try {
			vault(KEY_B, [KEY_C]).decrypt(sealed, context);
			expect.unreachable('an unknown key must not decrypt');
		} catch (error) {
			expect((error as Error).message).toContain(
				'credential encryption key is unavailable',
			);
			expect((error as { cause?: { code?: string } }).cause?.code).toBe(
				'KEY_UNKNOWN',
			);
		}
	});
});

describe('rotating stored provider credentials', () => {
	it('counts rows per key without writing, then re-seals them under the current key', async () => {
		const first = await connect('tenant-a', 'primary', KEY_A);
		const second = await connect('tenant-b', 'primary', KEY_A);

		const dry = await rotate(KEY_B, [KEY_A], false);
		expect(dry).toMatchObject({
			table: 'agent_provider_connections',
			currentKeyId: vault(KEY_B).keyId,
			counts: [{ keyId: vault(KEY_A).keyId, rows: 2 }],
			stale: 2,
			tenants: 2,
			rotated: 0,
			skipped: 0,
		});
		expect(
			(await storedCredential('tenant-a', first.id)).credential.keyId,
		).toBe(vault(KEY_A).keyId);

		const applied = await rotate(KEY_B, [KEY_A], true);
		expect(applied).toMatchObject({ stale: 2, rotated: 2, skipped: 0 });

		for (const [tenantId, created] of [
			['tenant-a', first],
			['tenant-b', second],
		] as const) {
			const stored = await storedCredential(tenantId, created.id);
			expect(stored.credential.keyId).toBe(vault(KEY_B).keyId);
			expect(
				vault(KEY_B).decrypt(
					stored.credential,
					credentialContext(stored.connection),
				),
			).toBe(CREDENTIAL);
		}
	});

	it('is a no-op on the second run', async () => {
		await connect('tenant-a', 'primary', KEY_A);
		await rotate(KEY_B, [KEY_A], true);

		const second = await rotate(KEY_B, [KEY_A], true);
		expect(second).toMatchObject({
			counts: [{ keyId: vault(KEY_B).keyId, rows: 1 }],
			stale: 0,
			tenants: 0,
			rotated: 0,
			skipped: 0,
		});
	});

	it('leaves the rotated rows readable under the new key alone', async () => {
		const created = await connect('tenant-a', 'primary', KEY_A);
		await rotate(KEY_B, [KEY_A], true);
		const stored = await storedCredential('tenant-a', created.id);
		const context = credentialContext(stored.connection);

		expect(vault(KEY_B).decrypt(stored.credential, context)).toBe(CREDENTIAL);
		expect(() => vault(KEY_A).decrypt(stored.credential, context)).toThrowError(
			/credential encryption key is unavailable/,
		);
	});

	it('does not touch the fields a caller can see', async () => {
		const created = await connect('tenant-a', 'primary', KEY_A);
		const before = await storedCredential('tenant-a', created.id);

		await rotate(KEY_B, [KEY_A], true);

		const after = await storedCredential('tenant-a', created.id);
		expect(after.connection).toEqual(before.connection);
	});

	it('walks every stale row when a batch holds one', async () => {
		for (const key of ['one', 'two', 'three']) {
			await connect('tenant-a', key, KEY_A);
		}

		const applied = await rotateProviderCredentials({
			runtime: runtime.database,
			background: background.database,
			vault: vault(KEY_B, [KEY_A]),
			apply: true,
			batchSize: 1,
		});

		expect(applied).toMatchObject({ stale: 3, rotated: 3, skipped: 0 });
		expect((await rotate(KEY_B, [KEY_A], false)).stale).toBe(0);
	});

	it('reads the inventory on a role that cannot see an envelope', async () => {
		await connect('tenant-a', 'primary', KEY_A);

		const inventory = await background.database.transaction(
			(transaction) =>
				transaction.query<{ tenant_id: string; credential_key_id: string }>({
					text: 'SELECT tenant_id, credential_key_id FROM agent_provider_connections',
				}),
			{ access: 'read' },
		);
		expect(inventory.rows).toEqual([
			{ tenant_id: 'tenant-a', credential_key_id: vault(KEY_A).keyId },
		]);

		for (const column of [
			'credential_ciphertext',
			'credential_iv',
			'credential_tag',
		]) {
			await expect(
				background.database.transaction(
					(transaction) =>
						transaction.query({
							text: `SELECT ${column} FROM agent_provider_connections`,
						}),
					{ access: 'read' },
				),
			).rejects.toBeDefined();
		}
	});

	it('refuses to run when the ring cannot open the stored rows', async () => {
		await connect('tenant-a', 'primary', KEY_A);

		await expect(rotate(KEY_B, [KEY_C], true)).rejects.toThrow(
			/credential encryption key is unavailable/,
		);
		expect((await rotate(KEY_A, [], false)).stale).toBe(0);
	});
});

describe('the agents secrets-rotate command', () => {
	const keys = {
		FD_AGENT_CREDENTIAL_KEY: KEY_B.toString('base64'),
		FD_AGENT_CREDENTIAL_KEY_PREVIOUS: KEY_A.toString('base64'),
	};
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const [name, value] of Object.entries(keys)) {
			saved.set(name, process.env[name]);
			process.env[name] = value;
		}
	});

	afterEach(() => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		saved.clear();
	});

	const command = cliExtension.commands.find(
		(entry) => entry.path.join(' ') === 'agents secrets-rotate',
	);

	function run(apply: boolean, databases = database.databases) {
		if (!command) throw new Error('agents secrets-rotate is not registered.');
		return command.execute({
			workspaceRoot: process.cwd(),
			moduleRoot: process.cwd(),
			apply,
			flags: new Map(),
			arguments: [],
			databases,
		});
	}

	it('is declared as a dry-run capable process capability', () => {
		expect(command?.capability).toMatchObject({
			id: 'agents.secrets.rotate',
			risk: 'process',
			requiresApprovedSpec: false,
			supportsDryRun: true,
		});
	});

	it('reports the inventory without writing, then re-seals with the environment key', async () => {
		const created = await connect('tenant-a', 'primary', KEY_A);

		const dry = await run(false);
		expect(dry.data).toMatchObject({
			moduleId: 'agents.core',
			table: 'agent_provider_connections',
			currentKeyId: vault(KEY_B).keyId,
			counts: [{ keyId: vault(KEY_A).keyId, rows: 1 }],
			stale: 1,
			rotated: 0,
		});
		expect(JSON.stringify(dry.data)).not.toContain(CREDENTIAL);

		const applied = await run(true);
		expect(applied.data).toMatchObject({ stale: 1, rotated: 1, skipped: 0 });
		expect(applied.warnings ?? []).toEqual([]);

		const stored = await storedCredential('tenant-a', created.id);
		expect(stored.credential.keyId).toBe(vault(KEY_B).keyId);
		expect(
			vault(KEY_B).decrypt(
				stored.credential,
				credentialContext(stored.connection),
			),
		).toBe(CREDENTIAL);
		expect((await run(true)).data).toMatchObject({ stale: 0, rotated: 0 });
	});

	it('leaves a row the application rewrote in between for the next run', async () => {
		const first = await connect('tenant-a', 'primary', KEY_A);
		const second = await connect('tenant-a', 'secondary', KEY_A);

		const contended = await run(true, databasesRewritingFirstRow('tenant-a'));

		expect(contended.data).toMatchObject({
			stale: 2,
			rotated: 1,
			skipped: 1,
		});
		expect(contended.warnings).toEqual([
			'1 rows were rewritten by the application while this ran and keep their own envelope. Run the command again.',
		]);

		const again = await run(true);
		expect(again.data).toMatchObject({ stale: 1, rotated: 1, skipped: 0 });
		expect(again.warnings ?? []).toEqual([]);
		for (const created of [first, second]) {
			const stored = await storedCredential('tenant-a', created.id);
			expect(stored.credential.keyId).toBe(vault(KEY_B).keyId);
			expect(
				vault(KEY_B).decrypt(
					stored.credential,
					credentialContext(stored.connection),
				),
			).toBe(CREDENTIAL);
		}
	});
});

describe('the key environment', () => {
	const saved = new Map<string, string | undefined>();

	function environment(values: Record<string, string>) {
		for (const [name, value] of Object.entries(values)) {
			saved.set(name, process.env[name]);
			process.env[name] = value;
		}
		return process.env;
	}

	afterEach(() => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		saved.clear();
	});

	it('opens an envelope written by a key listed in FD_AGENT_CREDENTIAL_KEY_PREVIOUS', () => {
		const context = credentialContext({
			tenantId: 'tenant-a',
			id: 'provider-1',
			kind: 'openai',
		});
		const sealed = vault(KEY_A).encrypt(CREDENTIAL, context);
		const configured = credentialVaultFromEnvironment(
			environment({
				FD_AGENT_CREDENTIAL_KEY: KEY_B.toString('base64'),
				FD_AGENT_CREDENTIAL_KEY_PREVIOUS: `${KEY_C.toString('base64')},${KEY_A.toString('base64')}`,
			}),
			'/tmp',
		);

		expect(configured.keyId).toBe(vault(KEY_B).keyId);
		expect(configured.decrypt(sealed, context)).toBe(CREDENTIAL);
	});

	it('names the variable that carries a bad previous key', () => {
		expect(() =>
			credentialVaultFromEnvironment(
				environment({
					FD_AGENT_CREDENTIAL_KEY: KEY_B.toString('base64'),
					FD_AGENT_CREDENTIAL_KEY_PREVIOUS: 'too-short',
				}),
				'/tmp',
			),
		).toThrowError(
			/FD_AGENT_CREDENTIAL_KEY_PREVIOUS must be a base64-encoded 32-byte key/,
		);
	});
});
