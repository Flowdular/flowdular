import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createPlatformDatabaseProvider,
	databaseProviderConfigFromEnvironment,
} from '../database.ts';
import { configuredDatabaseNeedsFirstRun } from './index.ts';
import { seedFirstRun } from './seed.ts';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe('configured database first run', () => {
	it('opens setup for an empty database and closes it after owner provisioning', async () => {
		const root = mkdtempSync(join(tmpdir(), 'flowdular-configured-setup-'));
		roots.push(root);
		const environment = {
			NODE_ENV: 'development',
			FD_DATABASE_ADAPTER: 'pglite',
			FD_DATABASE_PGLITE_DIRECTORY: join(root, 'data'),
		};
		expect(await configuredDatabaseNeedsFirstRun(environment, root)).toBe(true);

		const provider = createPlatformDatabaseProvider(
			databaseProviderConfigFromEnvironment(environment, root),
		);
		try {
			await seedFirstRun(provider, environment, root, {
				workspaceName: 'Acme Finance',
				workspaceSlug: 'acme-finance',
				ownerEmail: 'owner@acme.example',
				ownerName: 'Acme Owner',
				ownerPassword: 'S3cure!Brisk2026',
			});
		} finally {
			await provider.dispose();
		}
		expect(await configuredDatabaseNeedsFirstRun(environment, root)).toBe(
			false,
		);
	}, 180_000);

	it('fails startup when a configured database is unavailable', async () => {
		const root = mkdtempSync(join(tmpdir(), 'flowdular-unavailable-setup-'));
		roots.push(root);
		const environment = {
			NODE_ENV: 'production',
			FD_DATABASE_ADAPTER: 'postgresql',
			FD_DATABASE_URL:
				'postgresql://coreloom_runtime:example@127.0.0.1:1/flowdular',
			FD_DATABASE_MIGRATOR_URL:
				'postgresql://coreloom_migrator:example@127.0.0.1:1/flowdular',
			FD_DATABASE_BACKGROUND_URL:
				'postgresql://coreloom_background:example@127.0.0.1:1/flowdular',
		};
		await expect(
			configuredDatabaseNeedsFirstRun(environment, root),
		).rejects.toThrow();
	});
});
