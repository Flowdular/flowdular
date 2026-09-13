import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
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
import cliExtension from '../src/cli/index.ts';
import { rotateConnectorCredentials } from '../src/services/credential-rotation.ts';
import {
	AesGcmCredentialVault,
	credentialContext,
} from '../src/services/credential-vault.ts';
import type { StoredConnectorInstance } from '../src/services/repository.ts';
import {
	openConnectorsTestDatabase,
	type ConnectorsTestDatabase,
} from './support/database.ts';
import { seedInstance } from './support/harness.ts';

const KEY_A = Buffer.alloc(32, 0xa1);
const KEY_B = Buffer.alloc(32, 0xb2);
const KEY_C = Buffer.alloc(32, 0xc3);
const BASE_URL = 'https://api.example.test/v1';

let shared: ConnectorsTestDatabase;
let background: DatabaseAdapterLease;

beforeAll(async () => {
	shared = await openConnectorsTestDatabase();
	background = await shared.databases.acquire({
		namespace: 'connectors.core',
		purpose: 'background',
		requirements: {
			dialectIds: [DATABASE_DIALECT_IDS.postgresql],
			capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
		},
	});
});

afterEach(async () => {
	await shared.reset();
});

afterAll(async () => {
	await background?.release();
	await shared?.dispose();
});

function vault(current: Buffer, previous: readonly Buffer[] = []) {
	return new AesGcmCredentialVault(current, previous);
}

function seed(tenantId: string, name: string, key: Buffer, secret = name) {
	return seedInstance(shared.repository, vault(key), {
		tenantId,
		name,
		baseUrl: BASE_URL,
		allowedHosts: ['api.example.test'],
		credentials: { kind: 'api-key', header: 'x-api-key', value: secret },
	});
}

function seedWithoutCredential(tenantId: string, name: string) {
	return seedInstance(shared.repository, vault(KEY_A), {
		tenantId,
		name,
		baseUrl: BASE_URL,
		allowedHosts: ['api.example.test'],
	});
}

function rotate(current: Buffer, previous: readonly Buffer[], apply: boolean) {
	return rotateConnectorCredentials({
		runtime: shared.runtime,
		background: background.database,
		vault: vault(current, previous),
		apply,
	});
}

async function stored(instance: StoredConnectorInstance) {
	const found = await shared.repository.findInstance(
		instance.tenantId,
		instance.id,
	);
	if (!found) throw new Error(`No stored instance ${instance.id}.`);
	return found;
}

function opened(instance: StoredConnectorInstance, key: Buffer): string {
	if (!instance.credential) throw new Error('The instance has no envelope.');
	return vault(key).open(
		instance.credential,
		credentialContext(instance.tenantId, instance.id),
	);
}

interface StoredEnvelope extends DatabaseRow {
	id: string;
	credential_key_id: string;
	credential_iv: string;
	credential_tag: string;
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
   key while that transaction is still open, which is what an owner replacing
   a credential between the read and the update looks like to the rotation. */
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
				const context = credentialContext(tenantId, row.id);
				const sealed = vault(KEY_A).seal(
					vault(KEY_A).open(
						{
							keyId: row.credential_key_id,
							iv: row.credential_iv,
							tag: row.credential_tag,
							ciphertext: row.credential_ciphertext,
						},
						context,
					),
					context,
				);
				await transaction.execute({
					text: `UPDATE connectors_instances
					       SET credential_key_id = $1, credential_iv = $2, credential_tag = $3,
					           credential_ciphertext = $4
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
			const lease = await shared.databases.acquire(request);
			if (request.purpose !== 'runtime') return lease;
			return {
				database: handleRewritingFirstRow(lease.database, tenantId),
				release: () => lease.release(),
			};
		},
		dispose: () => shared.databases.dispose(),
	};
}

describe('rotating stored connector credentials', () => {
	it('counts rows per key without writing, then re-seals them under the current key', async () => {
		const first = await seed('tenant-a', 'First', KEY_A);
		const second = await seed('tenant-b', 'Second', KEY_A);
		const fresh = await seed('tenant-a', 'Fresh', KEY_B);
		await seedWithoutCredential('tenant-a', 'Open');

		const dry = await rotate(KEY_B, [KEY_A], false);
		expect(dry).toMatchObject({
			table: 'connectors_instances',
			currentKeyId: vault(KEY_B).keyId,
			counts: [
				{ keyId: vault(KEY_A).keyId, rows: 2 },
				{ keyId: vault(KEY_B).keyId, rows: 1 },
			].sort((left, right) => left.keyId.localeCompare(right.keyId)),
			stale: 2,
			tenants: 2,
			rotated: 0,
			skipped: 0,
			unknown: 0,
		});
		expect((await stored(first)).credential?.keyId).toBe(vault(KEY_A).keyId);

		const applied = await rotate(KEY_B, [KEY_A], true);
		expect(applied).toMatchObject({ stale: 2, rotated: 2, skipped: 0 });

		for (const seeded of [first, second, fresh]) {
			const row = await stored(seeded);
			expect(row.credential?.keyId).toBe(vault(KEY_B).keyId);
			expect(opened(row, KEY_B)).toBe(
				JSON.stringify({
					kind: 'api-key',
					header: 'x-api-key',
					value: seeded.name,
				}),
			);
		}
	});

	it('recomputes the fingerprint under the current key and nothing else an owner sees', async () => {
		const created = await seed('tenant-a', 'First', KEY_A);
		const before = await stored(created);
		const plaintext = opened(before, KEY_A);
		const context = credentialContext(before.tenantId, before.id);

		await rotate(KEY_B, [KEY_A], true);

		const after = await stored(created);
		expect(after.credentialFingerprint).toBe(
			vault(KEY_B).fingerprint(plaintext, context),
		);
		expect(after.credentialFingerprint).not.toBe(before.credentialFingerprint);
		const {
			credential: _a,
			credentialFingerprint: _b,
			...visibleAfter
		} = after;
		const {
			credential: _c,
			credentialFingerprint: _d,
			...visibleBefore
		} = before;
		expect(visibleAfter).toEqual(visibleBefore);
	});

	it('is a no-op on the second run', async () => {
		await seed('tenant-a', 'First', KEY_A);
		await rotate(KEY_B, [KEY_A], true);

		expect(await rotate(KEY_B, [KEY_A], true)).toMatchObject({
			counts: [{ keyId: vault(KEY_B).keyId, rows: 1 }],
			stale: 0,
			tenants: 0,
			rotated: 0,
			skipped: 0,
		});
	});

	it('leaves the rotated rows readable under the new key alone', async () => {
		const created = await seed('tenant-a', 'First', KEY_A);
		await rotate(KEY_B, [KEY_A], true);
		const row = await stored(created);

		expect(opened(row, KEY_B)).toContain('First');
		expect(() => opened(row, KEY_A)).toThrowError(
			/credential encryption key is unavailable/,
		);
	});

	it('walks every stale row when a batch holds one', async () => {
		for (const name of ['One', 'Two', 'Three']) {
			await seed('tenant-a', name, KEY_A);
		}

		const applied = await rotateConnectorCredentials({
			runtime: shared.runtime,
			background: background.database,
			vault: vault(KEY_B, [KEY_A]),
			apply: true,
			batchSize: 1,
		});

		expect(applied).toMatchObject({ stale: 3, rotated: 3, skipped: 0 });
		expect((await rotate(KEY_B, [KEY_A], false)).stale).toBe(0);
	});

	it('reports a row under a key the ring does not hold and leaves it', async () => {
		const foreign = await seed('tenant-a', 'Foreign', KEY_C);
		const stale = await seed('tenant-a', 'Stale', KEY_A);

		const dry = await rotate(KEY_B, [KEY_A], false);
		expect(dry).toMatchObject({
			counts: [
				{ keyId: vault(KEY_A).keyId, rows: 1 },
				{ keyId: vault(KEY_C).keyId, rows: 1 },
			].sort((left, right) => left.keyId.localeCompare(right.keyId)),
			stale: 1,
			tenants: 1,
			unknown: 1,
			rotated: 0,
		});

		const applied = await rotate(KEY_B, [KEY_A], true);
		expect(applied).toMatchObject({
			stale: 1,
			rotated: 1,
			skipped: 0,
			unknown: 1,
			refused: 0,
		});
		expect(await rotate(KEY_B, [KEY_A], false)).toMatchObject({
			stale: 0,
			unknown: 1,
		});
		expect((await stored(foreign)).credential).toEqual(foreign.credential);
		expect((await stored(stale)).credential?.keyId).toBe(vault(KEY_B).keyId);
	});

	it('leaves a row whose tag fails under the key it names and reports it', async () => {
		const broken = await seed('tenant-a', 'Broken', KEY_A);
		const intact = await seed('tenant-a', 'Intact', KEY_A);
		await shared.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: `UPDATE connectors_instances SET credential_tag = $3
					       WHERE tenant_id = $1 AND id = $2`,
					parameters: [
						'tenant-a',
						broken.id,
						Buffer.alloc(16, 0).toString('base64'),
					],
				}),
			{ access: 'write', tenantId: 'tenant-a' },
		);

		const applied = await rotate(KEY_B, [KEY_A], true);

		expect(applied).toMatchObject({
			stale: 2,
			rotated: 1,
			skipped: 0,
			refused: 1,
		});
		expect((await stored(broken)).credential).toMatchObject({
			keyId: vault(KEY_A).keyId,
			ciphertext: broken.credential?.ciphertext,
		});
		expect((await stored(intact)).credential?.keyId).toBe(vault(KEY_B).keyId);
	});

	it('reads the inventory on a role that cannot see an envelope', async () => {
		await seed('tenant-a', 'First', KEY_A);
		await seedWithoutCredential('tenant-a', 'Open');

		const inventory = await background.database.transaction(
			(transaction) =>
				transaction.query<{ tenant_id: string; credential_key_id: string }>({
					text: 'SELECT tenant_id, credential_key_id FROM connectors_instances',
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
			'credential_fingerprint',
		]) {
			await expect(
				background.database.transaction(
					(transaction) =>
						transaction.query({
							text: `SELECT ${column} FROM connectors_instances`,
						}),
					{ access: 'read' },
				),
			).rejects.toBeDefined();
		}
	});
});

describe('the connectors secrets-rotate command', () => {
	const keys = {
		FD_CONNECTORS_SECRET_KEY: KEY_B.toString('base64'),
		FD_CONNECTORS_SECRET_KEY_PREVIOUS: KEY_A.toString('base64'),
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
		(entry) => entry.path.join(' ') === 'connectors secrets-rotate',
	);

	function run(apply: boolean, databases = shared.databases) {
		if (!command) {
			throw new Error('connectors secrets-rotate is not registered.');
		}
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
			id: 'connectors.secrets.rotate',
			risk: 'process',
			requiresApprovedSpec: false,
			supportsDryRun: true,
		});
	});

	it('reports the inventory without writing, then re-seals with the environment key', async () => {
		const created = await seed('tenant-a', 'First', KEY_A, 'secret-value-0001');

		const dry = await run(false);
		expect(dry.data).toMatchObject({
			moduleId: 'connectors.core',
			table: 'connectors_instances',
			currentKeyId: vault(KEY_B).keyId,
			counts: [{ keyId: vault(KEY_A).keyId, rows: 1 }],
			stale: 1,
			rotated: 0,
		});
		expect(JSON.stringify(dry.data)).not.toContain('secret-value-0001');
		expect((await stored(created)).credential?.keyId).toBe(vault(KEY_A).keyId);

		const applied = await run(true);
		expect(applied.data).toMatchObject({ stale: 1, rotated: 1, skipped: 0 });
		expect(applied.warnings ?? []).toEqual([]);

		const row = await stored(created);
		expect(row.credential?.keyId).toBe(vault(KEY_B).keyId);
		expect(opened(row, KEY_B)).toContain('secret-value-0001');
		expect((await run(true)).data).toMatchObject({ stale: 0, rotated: 0 });
	});

	it('leaves a row the application rewrote in between for the next run', async () => {
		const first = await seed('tenant-a', 'First', KEY_A);
		const second = await seed('tenant-a', 'Second', KEY_A);

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
		for (const seeded of [first, second]) {
			const row = await stored(seeded);
			expect(row.credential?.keyId).toBe(vault(KEY_B).keyId);
			expect(opened(row, KEY_B)).toContain(seeded.name);
		}
	});

	it('warns about a row that fails authentication', async () => {
		const broken = await seed('tenant-a', 'Broken', KEY_A);
		await shared.runtime.transaction(
			(transaction) =>
				transaction.execute({
					text: `UPDATE connectors_instances SET credential_tag = $3
					       WHERE tenant_id = $1 AND id = $2`,
					parameters: [
						'tenant-a',
						broken.id,
						Buffer.alloc(16, 0).toString('base64'),
					],
				}),
			{ access: 'write', tenantId: 'tenant-a' },
		);

		const applied = await run(true);

		expect(applied.data).toMatchObject({ refused: 1, rotated: 0 });
		expect(applied.warnings).toEqual([
			'1 rows failed authentication under the key they name and were left as they are. Restore them from a database backup or replace the credential.',
		]);
	});

	it('warns about a row no key in the ring opens', async () => {
		await seed('tenant-a', 'Foreign', KEY_C);

		const applied = await run(true);

		expect(applied.data).toMatchObject({ unknown: 1, rotated: 0 });
		expect(applied.warnings).toEqual([
			'1 rows are sealed under a key this ring does not hold and were left as they are. Put that key back in FD_CONNECTORS_SECRET_KEY_PREVIOUS before retiring it.',
		]);
	});
});
