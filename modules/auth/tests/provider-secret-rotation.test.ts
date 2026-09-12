import type {
	DatabaseHandle,
	DatabaseOperationOptions,
	DatabaseRow,
	DatabaseStatement,
	DatabaseTransaction,
} from '@flowdular/database';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import cliExtension from '../src/cli/index.ts';
import { AuthService } from '../src/services/auth-service.ts';
import type { OidcDiscoveryPort } from '../src/services/identity-provider-service.ts';
import {
	PROVIDER_ROTATION_TABLE,
	rotateProviderSecrets,
} from '../src/services/provider-secret-rotation.ts';
import { createProviderSecretVault } from '../src/services/provider-secrets.ts';
import type { IdentityProviderRecord } from '../src/services/repository.ts';
import { fastHash } from './helpers.ts';
import {
	authTestProvider,
	closeAuthTestDatabases,
	createAuthTestDatabase,
	type AuthTestDatabase,
} from './support/database.ts';

const KEY_A = 'a1'.repeat(32);
const KEY_B = 'b2'.repeat(32);
const SECRET = 'workforce-client-secret';

const discovery: OidcDiscoveryPort = (issuer) =>
	Promise.resolve({
		authorizationEndpoint: `${issuer}/authorize`,
		tokenEndpoint: `${issuer}/token`,
		userInfoEndpoint: `${issuer}/userinfo`,
	});

const open = new Set<AuthTestDatabase>();

beforeAll(async () => {
	await authTestProvider();
}, 60_000);

afterEach(async () => {
	await Promise.all([...open].map((database) => database.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

function vault(current: string, previous: readonly string[] = []) {
	return createProviderSecretVault(current, previous);
}

function service(database: AuthTestDatabase, key: string): AuthService {
	return new AuthService(database.repository, {
		passwordHash: fastHash,
		now: () => 1_000_000,
		mfaEncryptionKey: key,
		oidcDiscovery: discovery,
	});
}

/* Two workspaces, each with a provider sealed under the key of the day: a
   provider row is workspace data, so a rotation that only looked at one
   workspace would report the other as done. */
async function fixture(key = KEY_A): Promise<{
	readonly database: AuthTestDatabase;
	readonly tenants: readonly string[];
}> {
	const database = await createAuthTestDatabase();
	open.add(database);
	const auth = service(database, key);
	const tenants: string[] = [];
	for (const [index, slug] of [
		'first-operations',
		'second-operations',
	].entries()) {
		const issued = await auth.signUp({
			email: `owner${index}@example.com`,
			password: 'correct horse battery staple',
			displayName: 'Ada Owner',
			organizationName: `Workspace ${index}`,
			organizationSlug: slug,
		});
		tenants.push(issued.principal.tenantId);
		await auth.identityProviders.create(
			{
				accountId: issued.principal.accountId,
				tenantId: issued.principal.tenantId,
				email: issued.principal.email,
				role: 'owner',
				scopes: issued.principal.scopes,
			},
			{
				key: 'workforce',
				label: 'Workforce',
				issuer: 'https://identity.example',
				clientId: 'client-id',
				clientSecret: SECRET,
			},
		);
	}
	return { database, tenants };
}

function rotate(
	database: AuthTestDatabase,
	tenants: readonly string[],
	current: string,
	previous: readonly string[],
	apply: boolean,
	handle: DatabaseHandle = database.runtime,
) {
	return rotateProviderSecrets({
		database: handle,
		tenants: () => Promise.resolve(tenants),
		vault: vault(current, previous),
		apply,
	});
}

async function rows(
	database: AuthTestDatabase,
	tenants: readonly string[],
): Promise<readonly IdentityProviderRecord[]> {
	const found: IdentityProviderRecord[] = [];
	for (const tenantId of tenants) {
		found.push(...(await database.repository.listIdentityProviders(tenantId)));
	}
	return found;
}

interface ProviderRow extends DatabaseRow {
	id: string;
	client_secret_ciphertext: string;
	client_secret_key_id: string;
}

/* The optimistic update refuses only a row whose envelope changed after the
   batch read it. This handle re-seals the first row of the batch under the old
   key while that transaction is still open, which is what an administrator
   rotating a secret between the read and the update looks like. */
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
			const row = result.rows[0] as ProviderRow | undefined;
			/* The batch statement carries its workspace as the first parameter,
			   which is what the envelope of those rows is bound to. */
			const tenantId = statement.text.includes('IS DISTINCT FROM')
				? String(statement.parameters?.[0] ?? '')
				: '';
			if (!resealed && tenantId && row?.client_secret_ciphertext) {
				resealed = true;
				const old = vault(KEY_A);
				const context = { tenantId, providerId: row.id };
				const sealed = old.seal(
					context,
					old.open(
						context,
						row.client_secret_ciphertext,
						row.client_secret_key_id,
					),
				);
				await transaction.execute({
					text: `UPDATE auth_identity_providers
					       SET client_secret_ciphertext = $1, client_secret_key_id = $2
					       WHERE id = $3`,
					parameters: [sealed.ciphertext, sealed.keyId, row.id],
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
		query: <Row extends DatabaseRow = DatabaseRow>(
			statement: DatabaseStatement,
			options?: DatabaseOperationOptions,
		) => handle.query<Row>(statement, options),
		execute: (statement, options) => handle.execute(statement, options),
		executeScript: (script, options) => handle.executeScript(script, options),
		transaction: (operation, options) =>
			handle.transaction(
				(transaction) => operation(session(transaction)),
				options,
			),
	};
}

describe('AUTH-PROVIDER-SECRET-ROTATE', () => {
	it('counts rows per key without writing, then re-seals every workspace', async () => {
		const { database, tenants } = await fixture();
		const before = await rows(database, tenants);

		const dry = await rotate(database, tenants, KEY_B, [KEY_A], false);

		expect(dry).toMatchObject({
			table: PROVIDER_ROTATION_TABLE,
			currentKeyId: vault(KEY_B).keyId,
			counts: [{ keyId: vault(KEY_A).keyId, rows: 2 }],
			stale: 2,
			rotated: 0,
			skipped: 0,
		});
		expect(await rows(database, tenants)).toEqual(before);

		const applied = await rotate(database, tenants, KEY_B, [KEY_A], true);

		expect(applied).toMatchObject({ stale: 2, rotated: 2, skipped: 0 });
		const after = await rows(database, tenants);
		for (const record of after) {
			expect(record.secretKeyId).toBe(vault(KEY_B).keyId);
			expect(
				vault(KEY_B).open(
					{ tenantId: record.tenantId, providerId: record.id },
					record.secretCiphertext,
					record.secretKeyId,
				),
			).toBe(SECRET);
		}
		/* The fingerprint is over the secret, and the secret did not change. */
		expect(after.map((record) => record.secretFingerprint)).toEqual(
			before.map((record) => record.secretFingerprint),
		);
	});

	it('keeps a sign-in through the rotated provider working', async () => {
		const { database, tenants } = await fixture();

		await rotate(database, tenants, KEY_B, [KEY_A], false);
		/* The retired key is still on the ring, so the flow works before apply. */
		expect(
			(await service(database, KEY_A).identityProviders.resolveSignIn(
				tenants[0]!,
				'workforce',
			))!.oidc.clientSecret,
		).toBe(SECRET);
		await rotate(database, tenants, KEY_B, [KEY_A], true);

		const rotated = new AuthService(database.repository, {
			passwordHash: fastHash,
			now: () => 1_000_000,
			mfaEncryptionKey: KEY_B,
			mfaPreviousEncryptionKeys: [KEY_A],
			oidcDiscovery: discovery,
		});
		expect(
			(await rotated.identityProviders.resolveSignIn(tenants[0]!, 'workforce'))!
				.oidc.clientSecret,
		).toBe(SECRET);
	});

	it('is a no-op on the second run', async () => {
		const { database, tenants } = await fixture();
		await rotate(database, tenants, KEY_B, [KEY_A], true);
		const after = await rows(database, tenants);

		const second = await rotate(database, tenants, KEY_B, [KEY_A], true);

		expect(second).toMatchObject({
			counts: [{ keyId: vault(KEY_B).keyId, rows: 2 }],
			stale: 0,
			rotated: 0,
			skipped: 0,
		});
		expect(await rows(database, tenants)).toEqual(after);
	});

	it('leaves a secret rotated in between for the next run', async () => {
		const { database, tenants } = await fixture();

		const contended = await rotate(
			database,
			tenants,
			KEY_B,
			[KEY_A],
			true,
			handleResealingFirstRow(database.runtime),
		);

		expect(contended).toMatchObject({ stale: 2, rotated: 1, skipped: 1 });

		const again = await rotate(database, tenants, KEY_B, [KEY_A], true);

		expect(again).toMatchObject({ stale: 1, rotated: 1, skipped: 0 });
		for (const record of await rows(database, tenants)) {
			expect(record.secretKeyId).toBe(vault(KEY_B).keyId);
			expect(
				vault(KEY_B).open(
					{ tenantId: record.tenantId, providerId: record.id },
					record.secretCiphertext,
					record.secretKeyId,
				),
			).toBe(SECRET);
		}
	});

	it('is reported per table by the operator command, which rotates both', async () => {
		const { database, tenants } = await fixture();
		const command = cliExtension.commands.find(
			(entry) => entry.path.join(' ') === 'auth secrets-rotate',
		)!;
		const saved = {
			current: process.env.FD_AUTH_MFA_KEY,
			previous: process.env.FD_AUTH_MFA_KEY_PREVIOUS,
		};
		process.env.FD_AUTH_MFA_KEY = KEY_B;
		process.env.FD_AUTH_MFA_KEY_PREVIOUS = KEY_A;
		try {
			const dry = await command.execute({
				workspaceRoot: process.cwd(),
				moduleRoot: process.cwd(),
				apply: false,
				flags: new Map(),
				arguments: [],
				databases: database.provider,
			});
			expect(dry.data).toMatchObject({
				moduleId: 'auth.core',
				table: 'auth_mfa_totp',
				providers: {
					table: PROVIDER_ROTATION_TABLE,
					currentKeyId: vault(KEY_B).keyId,
					stale: 2,
					rotated: 0,
				},
			});

			const applied = await command.execute({
				workspaceRoot: process.cwd(),
				moduleRoot: process.cwd(),
				apply: true,
				flags: new Map(),
				arguments: [],
				databases: database.provider,
			});

			expect(applied.data).toMatchObject({
				providers: { stale: 2, rotated: 2, skipped: 0 },
			});
			expect(applied.warnings ?? []).toEqual([]);
			expect(JSON.stringify(applied)).not.toContain(SECRET);
			for (const record of await rows(database, tenants)) {
				expect(record.secretKeyId).toBe(vault(KEY_B).keyId);
			}
		} finally {
			if (saved.current === undefined) delete process.env.FD_AUTH_MFA_KEY;
			else process.env.FD_AUTH_MFA_KEY = saved.current;
			if (saved.previous === undefined) {
				delete process.env.FD_AUTH_MFA_KEY_PREVIOUS;
			} else process.env.FD_AUTH_MFA_KEY_PREVIOUS = saved.previous;
		}
	});

	it('never reports a secret or key material', async () => {
		const { database, tenants } = await fixture();

		const printed = JSON.stringify(
			await rotate(database, tenants, KEY_B, [KEY_A], true),
		);

		for (const value of [SECRET, KEY_A, KEY_B]) {
			expect(printed).not.toContain(value);
		}
	});
});
