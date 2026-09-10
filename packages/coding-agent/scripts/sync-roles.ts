import { execFileSync } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SANDBOX_ROLE_DIRECTORY } from '../src/roles/registry.ts';
import { loadRoleDocuments, renderDefaultsModule } from '../src/roles/sync.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function workspaceRoot(): Promise<string> {
	let directory = packageRoot;
	for (;;) {
		try {
			await access(join(directory, 'flowdular.json'));
			return directory;
		} catch {
			const parent = dirname(directory);
			if (parent === directory) {
				throw new Error('No flowdular.json above the coding-agent package.');
			}
			directory = parent;
		}
	}
}

const root = await workspaceRoot();
const roles = await loadRoleDocuments(join(root, SANDBOX_ROLE_DIRECTORY));
const target = join(packageRoot, 'src/roles/defaults.ts');
await writeFile(target, renderDefaultsModule(roles), 'utf8');
execFileSync(join(root, 'node_modules/.bin/prettier'), ['--write', target], {
	stdio: 'inherit',
});
console.log(
	`Regenerated ${roles.length} roles into src/roles/defaults.ts from ${SANDBOX_ROLE_DIRECTORY}.`,
);
