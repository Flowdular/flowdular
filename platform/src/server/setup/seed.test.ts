import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseProvider } from '@flowdular/database';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createPlatformDatabaseProvider,
	databaseProviderConfigFromEnvironment,
} from '../database.ts';
import { configuredDatabaseNeedsFirstRun } from './index.ts';
import { FIRST_RUN_OPERATOR, seedFirstRun } from './seed.ts';

const SLOW = 180_000;
const OWNER = {
	workspaceName: 'Acme Finance',
	workspaceSlug: 'acme-finance',
	ownerEmail: 'owner@acme.example',
	ownerName: 'Acme Owner',
	ownerPassword: 'S3cure!Brisk2026',
};

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function deployment() {
	const root = mkdtempSync(join(tmpdir(), 'flowdular-setup-operator-'));
	roots.push(root);
	const environment = {
		NODE_ENV: 'development',
		FD_DATABASE_ADAPTER: 'pglite',
		FD_DATABASE_PGLITE_DIRECTORY: join(root, 'data'),
	};
	/* An embedded directory admits one open provider, so every step opens its
	   own and closes it before the next. */
	const withDatabase = async <T>(
		body: (databases: DatabaseProvider) => Promise<T>,
	): Promise<T> => {
		const databases = createPlatformDatabaseProvider(
			databaseProviderConfigFromEnvironment(environment, root),
		);
		try {
			return await body(databases);
		} finally {
			await databases.dispose();
		}
	};
	const withService = <T>(
		body: (
			service: Awaited<ReturnType<AuthRuntime['service']>>,
			databases: DatabaseProvider,
		) => Promise<T>,
	): Promise<T> =>
		withDatabase(async (databases) => {
			const auth = createAuthRuntime({
				...authRuntimeOptionsFromEnvironment(environment, root),
				databases,
			});
			try {
				return await body(await auth.service(), databases);
			} finally {
				await auth.dispose();
			}
		});
	const migrator = (databases: DatabaseProvider, text: string) =>
		databases
			.acquire({ namespace: 'auth.core', purpose: 'migration' })
			.then(async (lease) => {
				try {
					await lease.database.execute({ text });
				} finally {
					await lease.release();
				}
			});
	return { root, environment, withDatabase, withService, migrator };
}

describe('AUTH-OPERATOR-FIRST-WORKSPACE through first-run setup', () => {
	it(
		'records the workspace setup creates as the operator, with one event naming setup',
		async () => {
			const at = deployment();

			await at.withDatabase((databases) =>
				seedFirstRun(databases, at.environment, at.root, OWNER),
			);

			await at.withService(async (service) => {
				const operator = await service.operatorWorkspace();
				expect(operator).toMatchObject({
					workspace: { slug: OWNER.workspaceSlug },
					source: 'first-workspace',
				});
				const tenantId = operator!.workspace.tenantId;
				expect(await service.operatorStanding(tenantId)).toBe('own');
				const events = (
					await service.queryAudit({ tenantId, limit: 20 })
				).events.filter((event) => event.action === 'auth.operator.assigned');
				expect(events).toEqual([
					expect.objectContaining({
						actorLabel: FIRST_RUN_OPERATOR,
						metadata: { source: 'first-workspace' },
					}),
				]);
			});
		},
		SLOW,
	);

	it(
		'leaves no workspace and no record when the creating transaction fails, and offers setup again',
		async () => {
			const at = deployment();
			await at.withService(async (_service, databases) => {
				await at.migrator(
					databases,
					`ALTER TABLE auth_audit ADD CONSTRAINT setup_operator_refusal
					 CHECK (action <> 'auth.operator.assigned') NOT VALID`,
				);
			});

			await at.withDatabase((databases) =>
				expect(
					seedFirstRun(databases, at.environment, at.root, OWNER),
				).rejects.toThrow(),
			);

			expect(
				await configuredDatabaseNeedsFirstRun(at.environment, at.root),
			).toBe(true);
			await at.withService(async (service, databases) => {
				expect(await service.listTenants()).toEqual([]);
				expect(await service.operatorWorkspace()).toBeNull();
				await at.migrator(
					databases,
					'ALTER TABLE auth_audit DROP CONSTRAINT setup_operator_refusal',
				);
			});

			await at.withDatabase((databases) =>
				seedFirstRun(databases, at.environment, at.root, OWNER),
			);
			expect(
				await configuredDatabaseNeedsFirstRun(at.environment, at.root),
			).toBe(false);
			await at.withService(async (service) => {
				expect(await service.operatorWorkspace()).toMatchObject({
					workspace: { slug: OWNER.workspaceSlug },
					source: 'first-workspace',
				});
			});
		},
		SLOW,
	);
});
