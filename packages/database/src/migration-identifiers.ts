/* The adapter sets flowdular.tenant_id and nothing else, and only the
   flowdular_* roles exist. A policy on another setting sees no tenant (reads
   come back empty, every write fails its check), and a script that names
   another role fails when applied. These rules read the SQL alone, so module
   validation and the sandbox gate apply them without a database. */

export interface MigrationIdentifierIssue {
	readonly code: 'TENANT_SETTING_UNKNOWN' | 'ROLE_UNKNOWN';
	readonly message: string;
}

function statementsOf(sql: string): string {
	return sql.replace(/--[^\n]*\n/g, '\n');
}

function tenantSettings(body: string): ReadonlySet<string> {
	const found = new Set<string>();
	for (const match of body.matchAll(/'([a-z0-9_]+)\.tenant_id'/gi)) {
		found.add(`${match[1]!.toLowerCase()}.tenant_id`);
	}
	return found;
}

/* Names in role position: grant, revoke and policy target lists, SET ROLE
   and pg_roles lookups. FROM counts only inside REVOKE, where it names
   roles; elsewhere it names tables. */
function roleNames(body: string): ReadonlySet<string> {
	const found = new Set<string>();
	for (const match of body.matchAll(
		/(?:\b(?:TO|ROLE)|\bREVOKE\b[^;]*?\bFROM)\s+([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)/gi,
	)) {
		for (const name of match[1]!.split(/\s*,\s*/))
			found.add(name.toLowerCase());
	}
	for (const match of body.matchAll(/\brolname\s*=\s*'([a-z_][a-z0-9_]*)'/gi)) {
		found.add(match[1]!.toLowerCase());
	}
	return found;
}

export function migrationIdentifierIssues(
	sql: string,
): readonly MigrationIdentifierIssue[] {
	const body = statementsOf(sql);
	const issues: MigrationIdentifierIssue[] = [];
	for (const setting of tenantSettings(body)) {
		if (setting === 'flowdular.tenant_id') continue;
		issues.push({
			code: 'TENANT_SETTING_UNKNOWN',
			message: `"${setting}" is never set; tenant policies read current_setting('flowdular.tenant_id', true).`,
		});
	}
	for (const name of roleNames(body)) {
		const role = /^([a-z][a-z0-9]*)_(runtime|background|migrator)$/.exec(name);
		if (!role || role[1] === 'flowdular') continue;
		issues.push({
			code: 'ROLE_UNKNOWN',
			message: `Role "${name}" does not exist; use flowdular_${role[2]}.`,
		});
	}
	return issues;
}
