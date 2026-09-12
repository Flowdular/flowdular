import { randomUUID } from 'node:crypto';
import type {
	CliExtensionContext,
	CliExtensionResult,
} from '@flowdular/cli-protocol';
import {
	resetDatabase,
	type DatabaseAdapterLease,
	type DatabaseProvider,
} from '@flowdular/database';
import { MEMBER_SCOPES, OWNER_SCOPES } from '../acl/scopes.ts';
import {
	builtinRoleId,
	DatabaseAuthRepository,
	migrateAuthDatabase,
} from '../services/database-repository.ts';
import { hashPassword } from '../services/password.ts';
import { localDatabaseProvider, MIGRATION_REQUIREMENTS } from './database.ts';

export const GREENFIELD_ACCOUNTS = Object.freeze({
	admin: Object.freeze({
		email: 'admin@example.com',
		password: 'Owner!23456789',
		displayName: 'Local Administrator',
	}),
	user: Object.freeze({
		email: 'user@example.com',
		password: 'Member!2345678',
		displayName: 'Demo User',
	}),
});

export const GREENFIELD_TENANTS = Object.freeze({
	operations: 'Operations Demo',
	finance: 'Finance Demo',
});

export const GREENFIELD_TENANT_SLUGS = Object.freeze({
	operations: 'operations-demo',
	finance: 'finance-demo',
});

/**
 * Drops every table auth.core owns in this namespace, migrates it back, and
 * seeds the demo accounts. The provider is supplied so a caller decides which
 * database is reset; `runGreenfield` only ever hands it a local embedded one.
 */
export async function seedGreenfield(
	databases: DatabaseProvider,
): Promise<void> {
	const adminPasswordHash = await hashPassword(
		GREENFIELD_ACCOUNTS.admin.password,
	);
	const userPasswordHash = await hashPassword(
		GREENFIELD_ACCOUNTS.user.password,
	);
	const migration = await databases.acquire({
		namespace: 'auth.core',
		purpose: 'migration',
		requirements: MIGRATION_REQUIREMENTS,
	});
	try {
		await resetDatabase(migration.database, {
			intent: 'confirmed-destructive-reset',
		});
		await migrateAuthDatabase(migration.database);
	} finally {
		await migration.release();
	}
	const leases: DatabaseAdapterLease[] = [];
	try {
		const runtime = await databases.acquire({
			namespace: 'auth.core',
			purpose: 'runtime',
		});
		leases.push(runtime);
		const background = await databases.acquire({
			namespace: 'auth.core',
			purpose: 'background',
		});
		leases.push(background);
		const repository = new DatabaseAuthRepository({
			runtime: runtime.database,
			background: background.database,
		});
		const createdAt = Date.now();
		const adminAccountId = randomUUID();
		const operationsTenantId = randomUUID();
		await repository.createAccountWithTenant({
			accountId: adminAccountId,
			tenantId: operationsTenantId,
			email: GREENFIELD_ACCOUNTS.admin.email,
			normalizedEmail: GREENFIELD_ACCOUNTS.admin.email,
			passwordHash: adminPasswordHash,
			displayName: GREENFIELD_ACCOUNTS.admin.displayName,
			organizationName: GREENFIELD_TENANTS.operations,
			organizationSlug: GREENFIELD_TENANT_SLUGS.operations,
			role: 'owner',
			scopes: OWNER_SCOPES,
			createdAt,
		});
		await repository.createTenantMembership({
			accountId: adminAccountId,
			tenantId: randomUUID(),
			organizationName: GREENFIELD_TENANTS.finance,
			organizationSlug: GREENFIELD_TENANT_SLUGS.finance,
			role: 'owner',
			scopes: OWNER_SCOPES,
			createdAt: createdAt + 1,
		});
		await repository.createAccountInTenant({
			accountId: randomUUID(),
			tenantId: operationsTenantId,
			email: GREENFIELD_ACCOUNTS.user.email,
			normalizedEmail: GREENFIELD_ACCOUNTS.user.email,
			passwordHash: userPasswordHash,
			displayName: GREENFIELD_ACCOUNTS.user.displayName,
			role: 'member',
			roleId: builtinRoleId(operationsTenantId, 'member'),
			scopes: MEMBER_SCOPES,
			createdAt: createdAt + 2,
		});
	} finally {
		for (const lease of leases) await lease.release();
	}
}

export async function runGreenfield(
	context: CliExtensionContext,
): Promise<CliExtensionResult> {
	const environment =
		process.env.FD_ENV ?? process.env.NODE_ENV ?? 'development';
	if (environment !== 'development' && environment !== 'test') {
		throw new Error('Greenfield is restricted to development and test.');
	}
	const local = localDatabaseProvider(context.workspaceRoot);
	/* The reset drops every table in the namespace. A workstation runs the
	   embedded database; a configured server is somebody's deployment. */
	if (local.config.adapter !== 'pglite') {
		throw new Error(
			'Greenfield only resets the local embedded database. Unset the PostgreSQL connection configuration or reset that database manually.',
		);
	}
	const data = {
		applied: context.apply,
		database: local.location,
		accounts: GREENFIELD_ACCOUNTS,
		tenants: [GREENFIELD_TENANTS.operations, GREENFIELD_TENANTS.finance],
		next: 'Start the app, sign in as admin to switch tenants, or sign in as user to verify reduced scopes.',
	};
	if (!context.apply) {
		return {
			data,
			warnings: [
				'Stop the development server before applying this reset.',
				'No data was changed. Use --apply --confirm reset-local-auth to continue.',
			],
		};
	}
	const databases = local.create();
	try {
		await seedGreenfield(databases);
	} finally {
		await databases.dispose();
	}
	return {
		data,
		evidence: [local.location, 'modules/auth/spec/module.yaml'],
		warnings: [
			'These credentials are public development defaults. Never use this database in a deployed environment.',
		],
	};
}
