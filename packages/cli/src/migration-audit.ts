import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseMigration } from '@flowdular/database';

export interface MigrationAuditIssue {
	readonly moduleId: string;
	readonly migrationId: string;
	readonly code:
		| 'MIGRATION_SCRIPT_MISSING'
		| 'MIGRATION_NOT_DECLARED'
		| 'ROW_SECURITY_MISSING'
		| 'BACKGROUND_POLICY_TOO_WIDE';
	readonly message: string;
}

export interface MigrationAuditReport {
	readonly moduleId: string;
	readonly migrations: number;
	readonly issues: readonly MigrationAuditIssue[];
}

function statementsOf(sql: string): string {
	/* Comments must not contribute matches; the checks below read structure. */
	return sql.replace(/--[^\n]*\n/g, '\n');
}

function tables(sql: string): ReadonlySet<string> {
	const found = new Set<string>();
	for (const match of statementsOf(sql).matchAll(
		/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi,
	)) {
		found.add(match[1]!.toLowerCase());
	}
	return found;
}

/* A rebuild creates a temporary table, drops the original, and renames the new
   one into its place. Only the tables a script leaves behind can carry a
   policy, so the checks below read the final state, not every name mentioned. */
function remainingTables(sql: string): ReadonlySet<string> {
	const body = statementsOf(sql);
	const remaining = new Set(tables(sql));
	for (const match of body.matchAll(
		/DROP TABLE(?:\s+IF EXISTS)?\s+([a-z_][a-z0-9_]*)/gi,
	)) {
		remaining.delete(match[1]!.toLowerCase());
	}
	for (const match of body.matchAll(
		/ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+RENAME TO\s+([a-z_][a-z0-9_]*)/gi,
	)) {
		remaining.delete(match[1]!.toLowerCase());
		remaining.add(match[2]!.toLowerCase());
	}
	return remaining;
}

/* Only a table that carries a tenant_id column of its own needs a tenant
   policy. A global table declared in the same script (an account reached before
   any workspace is known, a module-owned definition, a child keyed by a
   tenant-scoped parent) must not be reported for missing one. */
function tenantTables(sql: string): ReadonlySet<string> {
	const body = statementsOf(sql);
	const found = new Set<string>();
	for (const match of body.matchAll(
		/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\)/gi,
	)) {
		if (/^\s*tenant_id\s+[a-z]/im.test(match[2]!)) {
			found.add(match[1]!.toLowerCase());
		}
	}
	for (const match of body.matchAll(
		/ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+tenant_id\b/gi,
	)) {
		found.add(match[1]!.toLowerCase());
	}
	for (const match of body.matchAll(
		/ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+RENAME TO\s+([a-z_][a-z0-9_]*)/gi,
	)) {
		if (found.has(match[1]!.toLowerCase())) found.add(match[2]!.toLowerCase());
	}
	return found;
}

/* -1 when no expression matches, so a later position always wins. */
function lastIndexOf(body: string, expressions: readonly RegExp[]): number {
	let position = -1;
	for (const expression of expressions) {
		for (const match of body.matchAll(expression)) {
			position = Math.max(position, match.index ?? -1);
		}
	}
	return position;
}

async function scripts(directory: string): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	let entries: readonly string[];
	try {
		entries = await readdir(directory);
	} catch {
		return found;
	}
	for (const entry of entries.filter((name) => name.endsWith('.up.sql'))) {
		found.set(
			entry.slice(0, -'.up.sql'.length),
			await readFile(join(directory, entry), 'utf8'),
		);
	}
	return found;
}

/**
 * Reads one module's committed migration scripts and reports what a deployment
 * would only discover at run time: a tenant table the runtime role could read
 * across tenants, a cross-tenant policy wider than a read, and a script the
 * ledger will never run because no `databaseMigrations` entry names it.
 * It never rewrites SQL.
 */
export async function moduleMigrationAudit(
	moduleId: string,
	moduleDirectory: string,
	declared: readonly DatabaseMigration[],
): Promise<MigrationAuditReport> {
	const found = await scripts(join(moduleDirectory, 'migrations'));
	const issues: MigrationAuditIssue[] = [];
	const declaredIds = new Set(declared.map((migration) => migration.id));

	for (const migrationId of [...declaredIds].sort()) {
		if (found.has(migrationId)) continue;
		issues.push({
			moduleId,
			migrationId,
			code: 'MIGRATION_SCRIPT_MISSING',
			message: `migrations/${migrationId}.up.sql is missing.`,
		});
	}

	for (const [migrationId, sql] of [...found].sort()) {
		const report = (
			code: MigrationAuditIssue['code'],
			message: string,
		): void => {
			issues.push({ moduleId, migrationId, code, message });
		};
		if (!declaredIds.has(migrationId)) {
			report(
				'MIGRATION_NOT_DECLARED',
				`databaseMigrations declares no migration "${migrationId}", so the script never runs.`,
			);
		}
		const body = statementsOf(sql);
		/* A tenant table without forced row security lets the runtime role read
		   another tenant, which is the isolation the adapter contract promises. */
		const scoped = tenantTables(sql);
		for (const table of remainingTables(sql)) {
			if (!scoped.has(table)) continue;
			/* A rebuild drops the table and its policies with it, so the row
			   security must be declared after the last statement that puts the
			   table in place, not merely somewhere in the script. */
			const established = lastIndexOf(body, [
				new RegExp(`CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+${table}\\b`, 'gi'),
				new RegExp(`RENAME TO\\s+${table}\\b`, 'gi'),
			]);
			const after = (expression: RegExp): boolean =>
				lastIndexOf(body, [expression]) > established;
			const enabled = after(
				new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'gi'),
			);
			const forced = after(
				new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'gi'),
			);
			const policy = after(
				new RegExp(`CREATE POLICY [a-z0-9_]+ ON ${table}\\b`, 'gi'),
			);
			if (!enabled || !forced || !policy) {
				report(
					'ROW_SECURITY_MISSING',
					`Table "${table}" needs ENABLE, FORCE and a tenant policy.`,
				);
			}
		}
		/* The cross-tenant role exists so a scheduler can find work. A policy that
		   grants it anything beyond SELECT would let it act on another tenant. */
		for (const match of body.matchAll(
			/CREATE POLICY\s+([a-z0-9_]+)\s+ON\s+([a-z0-9_]+)([\s\S]*?);/gi,
		)) {
			const clause = match[3] ?? '';
			if (!/\bTO\s+coreloom_background\b/i.test(clause)) continue;
			if (!/\bFOR\s+SELECT\b/i.test(clause)) {
				report(
					'BACKGROUND_POLICY_TOO_WIDE',
					`Policy "${match[1]}" on "${match[2]}" grants the background role more than FOR SELECT.`,
				);
			}
			if (/\bWITH\s+CHECK\b/i.test(clause)) {
				report(
					'BACKGROUND_POLICY_TOO_WIDE',
					`Policy "${match[1]}" on "${match[2]}" gives the background role a write path.`,
				);
			}
		}
	}
	return { moduleId, migrations: found.size, issues };
}
