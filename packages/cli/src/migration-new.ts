import { findModuleFiles } from './module-files.ts';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
	failure,
	success,
	type CommandEnvelope,
} from '@flowdular/cli-protocol';
import type { ModuleManifest } from '@flowdular/contracts';
import { scaffoldMigration } from './migration-scaffold.ts';
import { findNamedFiles } from './validation.ts';
import type { Workspace } from './workspace.ts';

export async function migrationScaffold(
	workspace: Workspace,
	moduleId: string,
	name: string,
	apply: boolean,
): Promise<CommandEnvelope> {
	const manifests = await findModuleFiles(workspace);
	for (const manifestPath of manifests) {
		const manifest = JSON.parse(
			await readFile(manifestPath, 'utf8'),
		) as ModuleManifest;
		if (manifest.id !== moduleId) continue;
		const stem = moduleId.split('.')[0]!.replaceAll('-', '_');
		try {
			const scaffolded = await scaffoldMigration(
				dirname(manifestPath),
				stem,
				name,
				apply,
			);
			return success(
				{ moduleId, applied: apply, ...scaffolded },
				{
					warnings: apply
						? [
								'Replace the scaffolded columns with the real schema, then add the migration to databaseMigrations; "migration verify" checks it.',
							]
						: ['No file was written. Re-run with --apply.'],
				},
			);
		} catch (error) {
			return failure(
				'MIGRATION_SCAFFOLD_FAILED',
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	return failure('MODULE_NOT_FOUND', `"${moduleId}" is not a module here.`);
}
