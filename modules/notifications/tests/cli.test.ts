import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type {
	CliExtensionContext,
	CliExtensionResult,
} from '@flowdular/cli-protocol';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
	type DatabaseProvider,
} from '@flowdular/database';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import { cliExtension } from '../src/cli/index.ts';

const WORKSPACE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MODULE_ROOT = fileURLToPath(new URL('../', import.meta.url));

let providers: DatabaseProvider[] = [];

afterEach(async () => {
	const open = providers;
	providers = [];
	for (const provider of open) await provider.dispose();
});

function freshDatabases(): DatabaseProvider {
	const provider = createPgliteTestProvider();
	providers.push(provider);
	return provider;
}

function run(
	databases: DatabaseProvider,
	apply: boolean,
): Promise<CliExtensionResult> {
	const command = cliExtension.commands.find(
		(candidate) => candidate.path.join(' ') === 'notifications secrets-rotate',
	);
	if (!command) throw new Error('The rotation command is missing.');
	const context: CliExtensionContext = {
		workspaceRoot: WORKSPACE_ROOT,
		moduleRoot: MODULE_ROOT,
		apply,
		flags: new Map<string, string | boolean>(),
		arguments: [],
		databases,
	};
	return Promise.resolve(command.execute(context));
}

async function inboxPresent(databases: DatabaseProvider): Promise<boolean> {
	const lease = await databases.acquire({
		namespace: 'notifications.core',
		purpose: 'migration',
		requirements: {
			dialectIds: [DATABASE_DIALECT_IDS.postgresql],
			capabilities: [DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION],
		},
	});
	try {
		return await lease.database.schema.hasTable('notifications_inbox');
	} finally {
		await lease.release();
	}
}

describe('notifications CLI schema', () => {
	/* A dry run is the operator asking what would happen. Creating this
	   module's tables on the way to that answer is a write they did not ask
	   for, and on a deployment database it is the wrong moment for schema. */
	it('applies no DDL without --apply', async () => {
		const databases = freshDatabases();

		await expect(run(databases, false)).rejects.toThrow(/no schema/);

		expect(await inboxPresent(databases)).toBe(false);
	});

	it('migrates and reports once the operator applies', async () => {
		const databases = freshDatabases();

		const result = await run(databases, true);

		expect(result.data).toMatchObject({ moduleId: 'notifications.core' });
		expect(await inboxPresent(databases)).toBe(true);
	});
}, 120_000);
