import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ScaffoldedMigration {
	readonly id: string;
	readonly files: readonly string[];
}

const NAME = /^[a-z][a-z0-9_]{2,48}$/;

function nextNumber(existing: readonly string[]): string {
	const highest = existing
		.filter((entry) => entry.endsWith('.up.sql'))
		.map((entry) => Number.parseInt(entry.slice(0, 4), 10))
		.filter((value) => Number.isSafeInteger(value))
		.reduce((left, right) => Math.max(left, right), 0);
	return String(highest + 1).padStart(4, '0');
}

/* The script is committed and checksummed, so the scaffold only writes the
   parts an author would otherwise have to remember: forced row-level security
   and a tenant policy on both the read and the write path. */
function tenantTable(table: string): string {
	return `CREATE TABLE IF NOT EXISTS ${table} (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${table}_tenant_created_idx
  ON ${table} (tenant_id, created_at, id);
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${table}_tenant_policy ON ${table}
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;
}

export async function scaffoldMigration(
	moduleDirectory: string,
	moduleStem: string,
	name: string,
	apply: boolean,
): Promise<ScaffoldedMigration> {
	if (!NAME.test(name)) {
		throw new Error(
			`"${name}" must be lowercase letters, digits and underscores, 3 to 49 characters.`,
		);
	}
	const directory = join(moduleDirectory, 'migrations');
	let existing: readonly string[] = [];
	try {
		existing = await readdir(directory);
	} catch {
		existing = [];
	}
	const id = `${nextNumber(existing)}_${moduleStem}_${name}`;
	const table = `${moduleStem}_${name}`;
	const files = [
		{
			path: join(directory, `${id}.up.sql`),
			body: tenantTable(table),
		},
		{
			path: join(directory, `${id}.down.sql`),
			body: `DROP POLICY IF EXISTS ${table}_tenant_policy ON ${table};\nDROP INDEX IF EXISTS ${table}_tenant_created_idx;\nDROP TABLE IF EXISTS ${table};\n`,
		},
	];
	if (apply) {
		await mkdir(directory, { recursive: true });
		for (const file of files) {
			await writeFile(file.path, file.body, { flag: 'wx' });
		}
	}
	return { id, files: files.map((file) => file.path) };
}
