import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import type {
	DatabaseHandle,
	DatabaseOperationOptions,
	DatabaseProvider,
	DatabaseRow,
	DatabaseSession,
	DatabaseStatement,
	DatabaseTransaction,
} from '@flowdular/database';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import cliExtension from '../src/cli/index.ts';
import { AuthService } from '../src/services/auth-service.ts';
import { IDENTITY_TENANT_CONTEXT } from '../src/services/database-repository.ts';
import {
	MFA_ROTATION_TABLE,
	rotateMfaSecrets,
} from '../src/services/mfa-rotation.ts';
import { createMfaSecretVault } from '../src/services/totp.ts';
import {
	authTestProvider,
	closeAuthTestDatabases,
	createAuthTestDatabase,
	type AuthTestDatabase,
} from './support/database.ts';

const KEY_A = 'a1'.repeat(32);
const KEY_B = 'b2'.repeat(32);
const KEY_C = 'c3'.repeat(32);
const PASSWORD = 'correct horse battery staple';

const fastHash = {
	cost: 2 ** 12,
	blockSize: 8,
	parallelization: 1,
	keyLength: 32,
	maxMemory: 32 * 1024 * 1024,
} as const;

const open = new Set<AuthTestDatabase>();

beforeAll(async () => {
	await authTestProvider();
}, 60_000);

afterEach(async () => {
	await Promise.all([...open].map((database) => database.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

async function fixture(): Promise<AuthTestDatabase> {
	const database = await createAuthTestDatabase();
	open.add(database);
	return database;
}

function vault(current: string, previous: readonly string[] = []) {
	return createMfaSecretVault(current, previous);
}

/* An independent TOTP implementation, so a broken one in the module cannot make
   a code verify against itself. */
function totp(secret: string, now: number): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0;
	let value = 0;
	const bytes: number[] = [];
	for (const character of secret) {
		value = (value << 5) | alphabet.indexOf(character);
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
	const digest = createHmac('sha1', Buffer.from(bytes))
		.update(counter)
		.digest();
	const offset = digest[digest.length - 1]! & 15;
	const integer =
		((digest[offset]! & 127) << 24) |
		(digest[offset + 1]! << 16) |
		(digest[offset + 2]! << 8) |
		digest[offset + 3]!;
	return String(integer % 1_000_000).padStart(6, '0');
}

/* The envelope exactly as auth.core wrote it before a key id existed: the three
   base64url parts, no additional data, no id anywhere. */
function legacyEnvelope(secret: string, key: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
	const ciphertext = Buffer.concat([
		cipher.update(secret, 'utf8'),
		cipher.final(),
	]);
	return `${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

function service(
	database: AuthTestDatabase,
	current: string,
	previous: readonly string[] = [],
	now = 1_000_000,
): AuthService {
	return new AuthService(database.repository, {
		passwordHash: fastHash,
		now: () => now,
		mfaEncryptionKey: current,
		mfaPreviousEncryptionKeys: previous,
	});
}

async function enrol(
	database: AuthTestDatabase,
	key: string,
	email = 'owner@example.com',
	slug = 'example-operations',
	now = 1_000_000,
): Promise<{ accountId: string; secret: string }> {
	const auth = service(database, key, [], now);
	const owner = await auth.signUp({
		email,
		password: PASSWORD,
		displayName: 'Ada Owner',
		organizationName: 'Example Operations',
		organizationSlug: slug,
	});
	const enrolled = await auth.enrollTotp(owner.principal.accountId);
	await auth.confirmTotp(owner.principal.accountId, totp(enrolled.secret, now));
	return { accountId: owner.principal.accountId, secret: enrolled.secret };
}

function storedFactors(database: AuthTestDatabase) {
	return database.runtime.transaction(
		async (transaction) =>
			(
				await transaction.query<{
					account_id: string;
					secret_ciphertext: string;
					key_id: string | null;
				}>({
					text: `SELECT account_id, secret_ciphertext, key_id
					       FROM auth_mfa_totp ORDER BY account_id`,
				})
			).rows,
		{ access: 'read', tenantId: IDENTITY_TENANT_CONTEXT },
	);
}

/** Turns a stored factor back into the row a deployment older than 0017 held. */
function forgetKeyId(database: AuthTestDatabase, accountId: string) {
	return database.runtime.transaction(
		(transaction) =>
			transaction.execute({
				text: 'UPDATE auth_mfa_totp SET key_id = NULL WHERE account_id = $1',
				parameters: [accountId],
			}),
		{ access: 'write', tenantId: IDENTITY_TENANT_CONTEXT },
	);
}

interface StoredFactorRow extends DatabaseRow {
	account_id: string;
	secret_ciphertext: string;
	key_id: string | null;
}

function forwardQuery(session: DatabaseSession) {
	return <Row extends DatabaseRow = DatabaseRow>(
		statement: DatabaseStatement,
		options?: DatabaseOperationOptions,
	) => session.query<Row>(statement, options);
}

/* The optimistic update refuses only a row whose envelope changed after the
   batch read it. This handle re-seals the first row of the batch under the old
   key while that transaction is still open, which is what an enrolment landing
   between the read and the update looks like to the rotation. The inventory
   query selects no envelope, so it never reaches the seam. */
function handleResealingFirstRow(handle: DatabaseHandle): DatabaseHandle {
	let resealed = false;
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
			const row = result.rows[0] as StoredFactorRow | undefined;
			if (!resealed && row?.secret_ciphertext) {
				resealed = true;
				const old = vault(KEY_A);
				const sealed = old.seal(old.open(row.secret_ciphertext, row.key_id));
				await transaction.execute({
					text: `UPDATE auth_mfa_totp SET secret_ciphertext = $1, key_id = $2
					       WHERE account_id = $3`,
					parameters: [sealed.ciphertext, sealed.keyId, row.account_id],
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

/* Only the runtime lease reads and writes the factors, so the command reaches
   the seam while the migration it takes first stays untouched. */
function databasesResealingFirstRow(
	database: AuthTestDatabase,
): DatabaseProvider {
	return {
		acquire: async (request) => {
			const lease = await database.provider.acquire(request);
			if (request.purpose !== 'runtime') return lease;
			return {
				database: handleResealingFirstRow(lease.database),
				release: () => lease.release(),
			};
		},
		dispose: () => database.provider.dispose(),
	};
}

function rotate(
	database: AuthTestDatabase,
	current: string,
	previous: readonly string[],
	apply: boolean,
	batchSize?: number,
) {
	return rotateMfaSecrets({
		database: database.runtime,
		vault: vault(current, previous),
		apply,
		...(batchSize === undefined ? {} : { batchSize }),
	});
}

describe('the MFA secret vault across a rotation', () => {
	it('opens a factor sealed before the rotation and seals new ones with the current key', () => {
		const sealed = vault(KEY_A).seal('JBSWY3DPEHPK3PXP');
		const rotated = vault(KEY_B, [KEY_A]);

		expect(rotated.open(sealed.ciphertext, sealed.keyId)).toBe(
			'JBSWY3DPEHPK3PXP',
		);
		expect(rotated.seal('JBSWY3DPEHPK3PXP').keyId).toBe(vault(KEY_B).keyId);
		expect(sealed.keyId).not.toBe(vault(KEY_B).keyId);
	});

	it('opens an envelope written before the key id column existed', () => {
		const envelope = legacyEnvelope('JBSWY3DPEHPK3PXP', KEY_A);

		expect(vault(KEY_B, [KEY_A]).open(envelope)).toBe('JBSWY3DPEHPK3PXP');
		expect(vault(KEY_A).open(envelope, null)).toBe('JBSWY3DPEHPK3PXP');
	});

	it('keeps the stored envelope shape, so an older reader still parses it', () => {
		const sealed = vault(KEY_A).seal('JBSWY3DPEHPK3PXP');
		const [iv, ciphertext, tag] = sealed.ciphertext.split('.');

		expect(sealed.ciphertext.split('.')).toHaveLength(3);
		expect(Buffer.from(iv!, 'base64url')).toHaveLength(12);
		expect(Buffer.from(tag!, 'base64url')).toHaveLength(16);
		expect(Buffer.from(ciphertext!, 'base64url').byteLength).toBe(16);
		expect(sealed.ciphertext).not.toContain(sealed.keyId);
	});

	it('refuses an envelope whose key is in neither slot, with the kernel code', () => {
		const sealed = vault(KEY_A).seal('JBSWY3DPEHPK3PXP');

		try {
			vault(KEY_B, [KEY_C]).open(sealed.ciphertext, sealed.keyId);
			expect.unreachable('an unknown key must not open an envelope');
		} catch (error) {
			expect(error).toMatchObject({
				code: 'MFA_CONFIGURATION_INVALID',
				status: 500,
			});
			expect((error as { cause?: { code?: string } }).cause?.code).toBe(
				'KEY_UNKNOWN',
			);
		}
	});

	it('refuses a deployment that configures no key at all', () => {
		expect(() => vault('')).toThrowError(/not configured for this deployment/);
		expect(() => createMfaSecretVault(undefined)).toThrowError(
			/not configured for this deployment/,
		);
	});
});

describe('an enrolled factor across a key rotation', () => {
	it('completes the sign-in challenge while the sealing key is only a previous key', async () => {
		const database = await fixture();
		const now = 1_000_000;
		const { secret } = await enrol(database, KEY_A);

		const rotated = service(database, KEY_B, [KEY_A], now);
		const challenge = await rotated.signIn({
			email: 'owner@example.com',
			password: PASSWORD,
		});
		expect(challenge.mfaRequired).toBe(true);
		const session = await rotated.completeMfaChallenge(
			challenge.token,
			totp(secret, now),
		);

		expect(session.principal.email).toBe('owner@example.com');
	});

	it('completes the challenge for a row that carries no key id at all', async () => {
		const database = await fixture();
		const now = 1_000_000;
		const { accountId, secret } = await enrol(database, KEY_A);
		await forgetKeyId(database, accountId);

		const rotated = service(database, KEY_B, [KEY_A], now);
		const challenge = await rotated.signIn({
			email: 'owner@example.com',
			password: PASSWORD,
		});
		const session = await rotated.completeMfaChallenge(
			challenge.token,
			totp(secret, now),
		);

		expect(session.principal.email).toBe('owner@example.com');
	});

	it('records the current key id on every new enrolment', async () => {
		const database = await fixture();
		await enrol(database, KEY_A);

		expect((await storedFactors(database))[0]?.key_id).toBe(vault(KEY_A).keyId);
	});
});

describe('rotating stored MFA secrets', () => {
	it('counts rows per key without writing, then re-seals them under the current key', async () => {
		const database = await fixture();
		const first = await enrol(database, KEY_A);
		const second = await enrol(
			database,
			KEY_A,
			'second@example.com',
			'second-operations',
		);
		await forgetKeyId(database, second.accountId);
		const before = await storedFactors(database);

		const dry = await rotate(database, KEY_B, [KEY_A], false);
		expect(dry).toMatchObject({
			table: MFA_ROTATION_TABLE,
			currentKeyId: vault(KEY_B).keyId,
			stale: 2,
			rotated: 0,
			skipped: 0,
		});
		expect(dry.counts).toHaveLength(2);
		expect(dry.counts).toEqual(
			expect.arrayContaining([
				{ keyId: vault(KEY_A).keyId, rows: 1 },
				{ keyId: null, rows: 1 },
			]),
		);
		expect(await storedFactors(database)).toEqual(before);

		const applied = await rotate(database, KEY_B, [KEY_A], true);
		expect(applied).toMatchObject({ stale: 2, rotated: 2, skipped: 0 });

		const after = await storedFactors(database);
		expect(after.map((row) => row.key_id)).toEqual([
			vault(KEY_B).keyId,
			vault(KEY_B).keyId,
		]);
		const secrets = [first, second].sort((left, right) =>
			left.accountId < right.accountId ? -1 : 1,
		);
		for (const [index, row] of after.entries()) {
			expect(vault(KEY_B).open(row.secret_ciphertext, row.key_id)).toBe(
				secrets[index]!.secret,
			);
		}
	});

	it('leaves the rotated rows readable under the new key alone', async () => {
		const database = await fixture();
		const now = 1_000_000;
		const { secret } = await enrol(database, KEY_A);

		await rotate(database, KEY_B, [KEY_A], true);

		const row = (await storedFactors(database))[0]!;
		expect(() => vault(KEY_A).open(row.secret_ciphertext, row.key_id)).toThrow(
			/MFA configuration is invalid/,
		);
		const rotated = service(database, KEY_B, [], now);
		const challenge = await rotated.signIn({
			email: 'owner@example.com',
			password: PASSWORD,
		});
		await expect(
			rotated.completeMfaChallenge(challenge.token, totp(secret, now)),
		).resolves.toMatchObject({ principal: { email: 'owner@example.com' } });
	});

	it('is a no-op on the second run', async () => {
		const database = await fixture();
		await enrol(database, KEY_A);
		await rotate(database, KEY_B, [KEY_A], true);
		const after = await storedFactors(database);

		const second = await rotate(database, KEY_B, [KEY_A], true);

		expect(second).toMatchObject({
			counts: [{ keyId: vault(KEY_B).keyId, rows: 1 }],
			stale: 0,
			rotated: 0,
			skipped: 0,
		});
		expect(await storedFactors(database)).toEqual(after);
	});

	it('walks every stale row when a batch holds one', async () => {
		const database = await fixture();
		for (const [index, email] of [
			'one@example.com',
			'two@example.com',
			'three@example.com',
		].entries()) {
			await enrol(database, KEY_A, email, `workspace-${index}`);
		}

		const applied = await rotate(database, KEY_B, [KEY_A], true, 1);

		expect(applied).toMatchObject({ stale: 3, rotated: 3, skipped: 0 });
		expect((await rotate(database, KEY_B, [KEY_A], false)).stale).toBe(0);
	});

	it('reports an empty table without touching it', async () => {
		const database = await fixture();

		expect(await rotate(database, KEY_B, [KEY_A], true)).toEqual({
			table: MFA_ROTATION_TABLE,
			currentKeyId: vault(KEY_B).keyId,
			counts: [],
			stale: 0,
			rotated: 0,
			skipped: 0,
		});
	});

	it('refuses to run when the ring cannot open the stored rows', async () => {
		const database = await fixture();
		await enrol(database, KEY_A);
		const before = await storedFactors(database);

		await expect(rotate(database, KEY_B, [KEY_C], true)).rejects.toMatchObject({
			code: 'MFA_CONFIGURATION_INVALID',
		});
		expect(await storedFactors(database)).toEqual(before);
	});
});

describe('the auth secrets-rotate command', () => {
	const keys = {
		FD_AUTH_MFA_KEY: KEY_B,
		FD_AUTH_MFA_KEY_PREVIOUS: `${KEY_C},${KEY_A}`,
	};
	const saved = new Map<string, string | undefined>();

	afterEach(() => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		saved.clear();
	});

	function environment(): void {
		for (const [name, value] of Object.entries(keys)) {
			saved.set(name, process.env[name]);
			process.env[name] = value;
		}
	}

	const command = cliExtension.commands.find(
		(entry) => entry.path.join(' ') === 'auth secrets-rotate',
	);

	function run(
		database: AuthTestDatabase,
		apply: boolean,
		databases: DatabaseProvider = database.provider,
	) {
		if (!command) throw new Error('auth secrets-rotate is not registered.');
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
		expect(command?.capability).toEqual({
			id: 'auth.secrets.rotate',
			version: 1,
			summary:
				'Re-seal enrolled TOTP secrets and workspace provider secrets with the current auth encryption key.',
			risk: 'process',
			requiresApprovedSpec: false,
			supportsDryRun: true,
		});
	});

	it('reports the inventory without writing, then re-seals with the environment keys', async () => {
		const database = await fixture();
		const { secret } = await enrol(database, KEY_A);
		environment();

		const dry = await run(database, false);
		expect(dry.data).toMatchObject({
			moduleId: 'auth.core',
			table: MFA_ROTATION_TABLE,
			currentKeyId: vault(KEY_B).keyId,
			counts: [{ keyId: vault(KEY_A).keyId, rows: 1 }],
			stale: 1,
			rotated: 0,
		});
		expect((await storedFactors(database))[0]?.key_id).toBe(vault(KEY_A).keyId);

		const applied = await run(database, true);
		expect(applied.data).toMatchObject({ stale: 1, rotated: 1, skipped: 0 });
		expect(applied.warnings ?? []).toEqual([]);
		expect((await storedFactors(database))[0]?.key_id).toBe(vault(KEY_B).keyId);
		expect((await run(database, true)).data).toMatchObject({
			stale: 0,
			rotated: 0,
		});
		expect(JSON.stringify(applied)).not.toContain(secret);
	});

	it('leaves a factor re-sealed in between for the next run', async () => {
		const database = await fixture();
		const first = await enrol(database, KEY_A);
		const second = await enrol(
			database,
			KEY_A,
			'second@example.com',
			'second-operations',
		);
		environment();

		const contended = await run(
			database,
			true,
			databasesResealingFirstRow(database),
		);

		expect(contended.data).toMatchObject({
			stale: 2,
			rotated: 1,
			skipped: 1,
		});
		expect(contended.warnings).toEqual([
			'1 factors were re-enrolled while this ran and keep their own envelope. Run the command again.',
		]);

		const again = await run(database, true);
		expect(again.data).toMatchObject({ stale: 1, rotated: 1, skipped: 0 });
		expect(again.warnings ?? []).toEqual([]);
		const secrets = new Map(
			[first, second].map((created) => [created.accountId, created.secret]),
		);
		const stored = await storedFactors(database);
		expect(stored.map((row) => row.key_id)).toEqual([
			vault(KEY_B).keyId,
			vault(KEY_B).keyId,
		]);
		for (const row of stored) {
			expect(vault(KEY_B).open(row.secret_ciphertext, row.key_id)).toBe(
				secrets.get(row.account_id),
			);
		}
	});

	it('never prints key material or an enrolled secret', async () => {
		const database = await fixture();
		const { secret } = await enrol(database, KEY_A);
		environment();

		const printed = JSON.stringify(await run(database, true));

		for (const key of [KEY_A, KEY_B, KEY_C]) {
			expect(printed).not.toContain(key);
		}
		expect(printed).not.toContain(secret);
		expect(printed).not.toContain('secret_ciphertext');
		expect(printed).toContain(vault(KEY_B).keyId);
	});

	it('refuses a workspace that configures no database', async () => {
		environment();
		if (!command) throw new Error('auth secrets-rotate is not registered.');

		await expect(
			command.execute({
				workspaceRoot: process.cwd(),
				moduleRoot: process.cwd(),
				apply: false,
				flags: new Map(),
				arguments: [],
			}),
		).rejects.toThrow(/deployment database/);
	});
});
