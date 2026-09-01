import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
	CliExtensionContext,
	CliExtensionResult,
} from '@coreloom/cli-protocol';
import { MEMBER_SCOPES, OWNER_SCOPES } from '../acl/scopes.ts';
import { hashPassword } from '../services/password.ts';
import {
	builtinRoleId,
	SqliteAuthRepository,
} from '../services/sqlite-repository.ts';

const databaseRelativePath = '.octane-erp/auth.db';

export const GREENFIELD_ACCOUNTS = Object.freeze({
	admin: Object.freeze({
		email: 'admin@example.com',
		password: 'Admin!23456789',
		displayName: 'Local Administrator',
	}),
	user: Object.freeze({
		email: 'user@example.com',
		password: 'User!234567890',
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

function ensureInside(root: string, candidate: string): void {
	const pathFromRoot = relative(root, candidate);
	if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
		throw new Error('The greenfield database path escapes the workspace.');
	}
}

async function resetDatabase(workspaceRoot: string, databasePath: string) {
	const canonicalWorkspace = await realpath(workspaceRoot);
	const stateDirectory = dirname(databasePath);
	try {
		const state = await lstat(stateDirectory);
		if (state.isSymbolicLink()) {
			throw new Error('The local state directory cannot be a symbolic link.');
		}
	} catch (error) {
		if (
			!(error instanceof Error && 'code' in error && error.code === 'ENOENT')
		) {
			throw error;
		}
		await mkdir(stateDirectory, { recursive: true });
	}
	const canonicalState = await realpath(stateDirectory);
	ensureInside(canonicalWorkspace, canonicalState);
	await Promise.all([
		rm(databasePath, { force: true }),
		rm(`${databasePath}-shm`, { force: true }),
		rm(`${databasePath}-wal`, { force: true }),
	]);
}

export async function runGreenfield(
	context: CliExtensionContext,
): Promise<CliExtensionResult> {
	const environment =
		process.env.OERP_ENV ?? process.env.NODE_ENV ?? 'development';
	if (environment !== 'development' && environment !== 'test') {
		throw new Error('Greenfield is restricted to development and test.');
	}
	const databasePath = resolve(context.workspaceRoot, databaseRelativePath);
	ensureInside(context.workspaceRoot, databasePath);
	if (process.env.OERP_AUTH_DATABASE) {
		const configured = resolve(
			context.workspaceRoot,
			process.env.OERP_AUTH_DATABASE,
		);
		if (configured !== databasePath) {
			throw new Error(
				'Greenfield only resets .octane-erp/auth.db. Unset OERP_AUTH_DATABASE or reset the custom adapter manually.',
			);
		}
	}

	const data = {
		applied: context.apply,
		database: databaseRelativePath,
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

	const adminPasswordHash = await hashPassword(
		GREENFIELD_ACCOUNTS.admin.password,
	);
	const userPasswordHash = await hashPassword(
		GREENFIELD_ACCOUNTS.user.password,
	);
	await resetDatabase(context.workspaceRoot, databasePath);
	const repository = new SqliteAuthRepository(databasePath);
	try {
		const createdAt = Date.now();
		const adminAccountId = randomUUID();
		const operationsTenantId = randomUUID();
		repository.createAccountWithTenant({
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
		repository.createTenantMembership({
			accountId: adminAccountId,
			tenantId: randomUUID(),
			organizationName: GREENFIELD_TENANTS.finance,
			organizationSlug: GREENFIELD_TENANT_SLUGS.finance,
			role: 'owner',
			scopes: OWNER_SCOPES,
			createdAt: createdAt + 1,
		});
		repository.createAccountInTenant({
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
		repository.close();
	}
	return {
		data,
		evidence: [databaseRelativePath, 'modules/auth/spec/module.yaml'],
		warnings: [
			'These credentials are public development defaults. Never use this database in a deployed environment.',
		],
	};
}
