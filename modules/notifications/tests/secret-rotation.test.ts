import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import type {
	DatabaseHandle,
	DatabaseOperationOptions,
	DatabaseProvider,
	DatabaseRow,
	DatabaseSession,
	DatabaseStatement,
	DatabaseTransaction,
} from '@flowdular/database';
import cliExtension from '../src/cli/index.ts';
import { rotateWebhookSecrets } from '../src/services/secret-rotation.ts';
import {
	AesGcmSecretVault,
	secretContext,
	secretVaultFromEnvironment,
} from '../src/services/secret-vault.ts';
import { WebhookSubscriptionService } from '../src/services/webhook-service.ts';
import {
	createWebhookEgressPolicy,
	webhookHostAllowlist,
} from '../src/services/egress.ts';
import {
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';
import { publicResolver } from './support/harness.ts';

const KEY_A = Buffer.alloc(32, 0xa1);
const KEY_B = Buffer.alloc(32, 0xb2);
const KEY_C = Buffer.alloc(32, 0xc3);
const NOW = 1_700_000_000_000;
const RESOLVER = publicResolver({ 'hooks.example': '93.184.216.34' });

let shared: NotificationsTestDatabase;

beforeAll(async () => {
	shared = await openNotificationsTestDatabase();
});

afterEach(async () => {
	await shared.reset();
});

afterAll(async () => {
	await shared?.dispose();
});

function vault(current: Buffer, previous: readonly Buffer[] = []) {
	return new AesGcmSecretVault(current, previous);
}

async function createSubscription(
	tenantId: string,
	name: string,
	key: Buffer,
): Promise<{ readonly id: string; readonly secret: string }> {
	const service = new WebhookSubscriptionService(
		shared.repository,
		vault(key),
		() =>
			createWebhookEgressPolicy({
				allowlist: webhookHostAllowlist(''),
				resolve: RESOLVER,
			}),
		() => NOW,
	);
	const created = await service.create(tenantId, 'account-rotation', {
		name,
		url: 'https://hooks.example/receiver',
		events: ['agent-run-failed'],
	});
	return { id: created.subscription.id, secret: created.secret };
}

function rotate(current: Buffer, previous: readonly Buffer[], apply: boolean) {
	return rotateWebhookSecrets({
		runtime: shared.runtime,
		background: shared.background,
		vault: vault(current, previous),
		apply,
	});
}

async function storedSubscription(tenantId: string, id: string) {
	const stored = await shared.repository.getSubscription(tenantId, id);
	if (!stored) throw new Error(`No stored subscription ${id}.`);
	return stored;
}

interface StoredEnvelope extends DatabaseRow {
	id: string;
	secret_key_id: string;
	secret_iv: string;
	secret_tag: string;
	secret_ciphertext: string;
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
			if (!rewritten && row?.secret_ciphertext) {
				rewritten = true;
				const context = secretContext(tenantId, row.id);
				const sealed = vault(KEY_A).encrypt(
					vault(KEY_A).decrypt(
						{
							keyId: row.secret_key_id,
							iv: row.secret_iv,
							tag: row.secret_tag,
							ciphertext: row.secret_ciphertext,
						},
						context,
					),
					context,
				);
				await transaction.execute({
					text: `UPDATE notifications_webhook_subscriptions
					       SET secret_key_id = $1, secret_iv = $2, secret_tag = $3,
					           secret_ciphertext = $4
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

describe('the secret vault across a rotation', () => {
	const context = secretContext('tenant-a', 'subscription-1');

	it('opens an envelope written before the rotation and writes the new key', () => {
		const sealed = vault(KEY_A).encrypt('webhook-secret-value', context);
		const rotated = vault(KEY_B, [KEY_A]);

		expect(rotated.decrypt(sealed, context)).toBe('webhook-secret-value');
		expect(rotated.encrypt('webhook-secret-value', context).keyId).toBe(
			vault(KEY_B).keyId,
		);
	});

	it('refuses an envelope whose key is in neither slot, with a stable code', () => {
		const sealed = vault(KEY_A).encrypt('webhook-secret-value', context);

		try {
			vault(KEY_B, [KEY_C]).decrypt(sealed, context);
			expect.unreachable('an unknown key must not decrypt');
		} catch (error) {
			expect((error as Error).message).toContain(
				'secret encryption key is unavailable',
			);
			expect((error as { cause?: { code?: string } }).cause?.code).toBe(
				'KEY_UNKNOWN',
			);
		}
	});
});

describe('rotating stored webhook secrets', () => {
	it('counts rows per key without writing, then re-seals them under the current key', async () => {
		const first = await createSubscription('tenant-a', 'First', KEY_A);
		const second = await createSubscription('tenant-b', 'Second', KEY_A);

		const dry = await rotate(KEY_B, [KEY_A], false);
		expect(dry).toMatchObject({
			table: 'notifications_webhook_subscriptions',
			currentKeyId: vault(KEY_B).keyId,
			counts: [{ keyId: vault(KEY_A).keyId, rows: 2 }],
			stale: 2,
			tenants: 2,
			rotated: 0,
			skipped: 0,
		});
		expect((await storedSubscription('tenant-a', first.id)).secret.keyId).toBe(
			vault(KEY_A).keyId,
		);

		const applied = await rotate(KEY_B, [KEY_A], true);
		expect(applied).toMatchObject({ stale: 2, rotated: 2, skipped: 0 });

		for (const [tenantId, created] of [
			['tenant-a', first],
			['tenant-b', second],
		] as const) {
			const stored = await storedSubscription(tenantId, created.id);
			expect(stored.secret.keyId).toBe(vault(KEY_B).keyId);
			expect(
				vault(KEY_B).decrypt(
					stored.secret,
					secretContext(stored.tenantId, stored.id),
				),
			).toBe(created.secret);
		}
	});

	it('is a no-op on the second run', async () => {
		await createSubscription('tenant-a', 'First', KEY_A);
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
		const created = await createSubscription('tenant-a', 'First', KEY_A);
		await rotate(KEY_B, [KEY_A], true);
		const stored = await storedSubscription('tenant-a', created.id);
		const context = secretContext(stored.tenantId, stored.id);

		expect(vault(KEY_B).decrypt(stored.secret, context)).toBe(created.secret);
		expect(() => vault(KEY_A).decrypt(stored.secret, context)).toThrowError(
			/secret encryption key is unavailable/,
		);
	});

	it('does not count as a secret change a caller can see', async () => {
		const created = await createSubscription('tenant-a', 'First', KEY_A);
		const before = await shared.repository.getSubscription(
			'tenant-a',
			created.id,
		);

		await rotate(KEY_B, [KEY_A], true);

		expect(before).toMatchObject({ secretRevision: 1 });
		const after = await storedSubscription('tenant-a', created.id);
		expect({
			secretRevision: after.secretRevision,
			secretFingerprint: after.secretFingerprint,
			updatedAt: after.updatedAt,
		}).toEqual({
			secretRevision: before!.secretRevision,
			secretFingerprint: before!.secretFingerprint,
			updatedAt: before!.updatedAt,
		});
	});

	it('walks every stale row when a batch holds one', async () => {
		for (const name of ['One', 'Two', 'Three']) {
			await createSubscription('tenant-a', name, KEY_A);
		}

		const applied = await rotateWebhookSecrets({
			runtime: shared.runtime,
			background: shared.background,
			vault: vault(KEY_B, [KEY_A]),
			apply: true,
			batchSize: 1,
		});

		expect(applied).toMatchObject({ stale: 3, rotated: 3, skipped: 0 });
		expect((await rotate(KEY_B, [KEY_A], false)).stale).toBe(0);
	});

	it('reads the inventory on a role that cannot see an envelope', async () => {
		await createSubscription('tenant-a', 'First', KEY_A);

		const inventory = await shared.background.transaction(
			(transaction) =>
				transaction.query<{ tenant_id: string; secret_key_id: string }>({
					text: `SELECT tenant_id, secret_key_id
					 FROM notifications_webhook_subscriptions`,
				}),
			{ access: 'read' },
		);
		expect(inventory.rows).toEqual([
			{ tenant_id: 'tenant-a', secret_key_id: vault(KEY_A).keyId },
		]);

		for (const column of ['secret_ciphertext', 'secret_iv', 'secret_tag']) {
			await expect(
				shared.background.transaction(
					(transaction) =>
						transaction.query({
							text: `SELECT ${column} FROM notifications_webhook_subscriptions`,
						}),
					{ access: 'read' },
				),
			).rejects.toBeDefined();
		}
	});

	it('refuses to run when the ring cannot open the stored rows', async () => {
		await createSubscription('tenant-a', 'First', KEY_A);

		await expect(rotate(KEY_B, [KEY_C], true)).rejects.toThrow(
			/secret encryption key is unavailable/,
		);
		expect((await rotate(KEY_A, [], false)).stale).toBe(0);
	});
});

describe('the notifications secrets-rotate command', () => {
	const keys = {
		FD_NOTIFICATIONS_SECRET_KEY: KEY_B.toString('base64'),
		FD_NOTIFICATIONS_SECRET_KEY_PREVIOUS: KEY_A.toString('base64'),
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
		(entry) => entry.path.join(' ') === 'notifications secrets-rotate',
	);

	function run(apply: boolean, databases = shared.databases) {
		if (!command) {
			throw new Error('notifications secrets-rotate is not registered.');
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
			id: 'notifications.secrets.rotate',
			risk: 'process',
			requiresApprovedSpec: false,
			supportsDryRun: true,
		});
	});

	it('reports the inventory without writing, then re-seals with the environment key', async () => {
		const created = await createSubscription('tenant-a', 'First', KEY_A);

		const dry = await run(false);
		expect(dry.data).toMatchObject({
			moduleId: 'notifications.core',
			table: 'notifications_webhook_subscriptions',
			currentKeyId: vault(KEY_B).keyId,
			counts: [{ keyId: vault(KEY_A).keyId, rows: 1 }],
			stale: 1,
			rotated: 0,
		});
		expect(JSON.stringify(dry.data)).not.toContain(created.secret);
		expect(
			(await storedSubscription('tenant-a', created.id)).secret.keyId,
		).toBe(vault(KEY_A).keyId);

		const applied = await run(true);
		expect(applied.data).toMatchObject({ stale: 1, rotated: 1, skipped: 0 });
		expect(applied.warnings ?? []).toEqual([]);

		const stored = await storedSubscription('tenant-a', created.id);
		expect(stored.secret.keyId).toBe(vault(KEY_B).keyId);
		expect(
			vault(KEY_B).decrypt(
				stored.secret,
				secretContext(stored.tenantId, stored.id),
			),
		).toBe(created.secret);
		expect((await run(true)).data).toMatchObject({ stale: 0, rotated: 0 });
	});

	it('leaves a row the application rewrote in between for the next run', async () => {
		const first = await createSubscription('tenant-a', 'First', KEY_A);
		const second = await createSubscription('tenant-a', 'Second', KEY_A);

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
			const stored = await storedSubscription('tenant-a', created.id);
			expect(stored.secret.keyId).toBe(vault(KEY_B).keyId);
			expect(
				vault(KEY_B).decrypt(
					stored.secret,
					secretContext(stored.tenantId, stored.id),
				),
			).toBe(created.secret);
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

	it('opens an envelope written by a key listed in FD_NOTIFICATIONS_SECRET_KEY_PREVIOUS', () => {
		const context = secretContext('tenant-a', 'subscription-1');
		const sealed = vault(KEY_A).encrypt('webhook-secret-value', context);
		const configured = secretVaultFromEnvironment(
			environment({
				FD_NOTIFICATIONS_SECRET_KEY: KEY_B.toString('base64'),
				FD_NOTIFICATIONS_SECRET_KEY_PREVIOUS: `${KEY_C.toString('base64')},${KEY_A.toString('base64')}`,
			}),
			'/tmp',
		);

		expect(configured.keyId).toBe(vault(KEY_B).keyId);
		expect(configured.decrypt(sealed, context)).toBe('webhook-secret-value');
		expect(configured.encrypt('webhook-secret-value', context).keyId).toBe(
			vault(KEY_B).keyId,
		);
	});

	it('names the variable that carries a bad previous key', () => {
		expect(() =>
			secretVaultFromEnvironment(
				environment({
					FD_NOTIFICATIONS_SECRET_KEY: KEY_B.toString('base64'),
					FD_NOTIFICATIONS_SECRET_KEY_PREVIOUS: 'too-short',
				}),
				'/tmp',
			),
		).toThrowError(
			/FD_NOTIFICATIONS_SECRET_KEY_PREVIOUS must be a base64-encoded 32-byte key/,
		);
	});
});
