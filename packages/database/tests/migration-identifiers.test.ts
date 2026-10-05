import { describe, expect, it } from 'vitest';
import { migrationIdentifierIssues } from '../src/index.ts';

const POLICY = `CREATE POLICY demo_records_tenant_policy ON demo_records
  USING (tenant_id = current_setting('flowdular.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('flowdular.tenant_id', true));
`;

function found(sql: string): readonly string[] {
	return migrationIdentifierIssues(sql).map(
		(issue) => `${issue.code} ${/"([^"]+)"/.exec(issue.message)?.[1]}`,
	);
}

describe('migration identifier rules', () => {
	it('accepts the flowdular setting and roles, wherever they appear', () => {
		expect(
			found(`${POLICY}
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowdular_background') THEN
    RAISE EXCEPTION 'The flowdular_background role must exist before this migration.';
  END IF;
END
$$;
CREATE POLICY demo_records_background_policy ON demo_records
  FOR SELECT TO flowdular_runtime, "flowdular_background" USING (true);
GRANT SELECT (tenant_id) ON demo_records TO flowdular_background;
SELECT current_setting('FLOWDULAR.TENANT_ID', true);
`),
		).toEqual([]);
	});

	/* Each of these names a role-shaped identifier in a position that is not
	   a role, so a correct script must not be reported. */
	it.each([
		[
			'a renamed column',
			'ALTER TABLE demo_records RENAME COLUMN started TO job_runtime;',
		],
		[
			'a renamed table',
			'ALTER TABLE demo_records_v2 RENAME TO sync_background;',
		],
		[
			'a comment string',
			"COMMENT ON TABLE demo_records IS 'copied to batch_runtime';",
		],
		['a line comment', '-- GRANT SELECT ON demo_records TO legacy_runtime;'],
		[
			'a block comment',
			'/* GRANT SELECT ON demo_records TO legacy_runtime; */',
		],
		['a nested block comment', '/* outer /* inner */ TO legacy_runtime */'],
		[
			'a column list',
			'GRANT SELECT (tenant_id, job_runtime) ON demo_records TO flowdular_background;',
		],
		['a table after FROM', 'DELETE FROM job_runtime;'],
	])('does not read %s as a role', (_label, statement) => {
		expect(found(`${POLICY}${statement}\n`)).toEqual([]);
	});

	it.each([
		[
			'a setting other than tenant_id',
			"SELECT current_setting('legacy.tenant', true);",
			'TENANT_SETTING_UNKNOWN legacy.tenant',
		],
		[
			'a dollar-quoted setting',
			'SELECT current_setting($$legacy.tenant_id$$, true);',
			'TENANT_SETTING_UNKNOWN legacy.tenant_id',
		],
		[
			'an escape-string setting',
			"SELECT current_setting(E'legacy.tenant_id', true);",
			'TENANT_SETTING_UNKNOWN legacy.tenant_id',
		],
		[
			'a tenant setting in set_config',
			"SELECT set_config('legacy.tenant_id', 'a', true);",
			'TENANT_SETTING_UNKNOWN legacy.tenant_id',
		],
		[
			'a role membership grant',
			'GRANT legacy_runtime TO flowdular_migrator;',
			'ROLE_UNKNOWN legacy_runtime',
		],
		[
			'a role membership revoke',
			'REVOKE legacy_runtime FROM flowdular_migrator;',
			'ROLE_UNKNOWN legacy_runtime',
		],
		[
			'a quoted role',
			'GRANT SELECT ON demo_records TO "legacy_background";',
			'ROLE_UNKNOWN legacy_background',
		],
		[
			'a role after another one',
			'GRANT SELECT ON demo_records TO flowdular_runtime, legacy_background;',
			'ROLE_UNKNOWN legacy_background',
		],
		[
			'a revoked role',
			'REVOKE ALL ON demo_records FROM legacy_runtime;',
			'ROLE_UNKNOWN legacy_runtime',
		],
		[
			'a session authorization',
			'SET SESSION AUTHORIZATION legacy_runtime;',
			'ROLE_UNKNOWN legacy_runtime',
		],
		[
			'a dropped role',
			'DROP ROLE IF EXISTS legacy_migrator;',
			'ROLE_UNKNOWN legacy_migrator',
		],
		[
			'a rolname comparison',
			"SELECT 1 FROM pg_roles WHERE rolname = 'legacy_background';",
			'ROLE_UNKNOWN legacy_background',
		],
		[
			'a grant inside a DO block',
			'DO $$ BEGIN GRANT SELECT ON demo_records TO legacy_background; END $$;',
			'ROLE_UNKNOWN legacy_background',
		],
		[
			'a grant run through EXECUTE',
			"DO $body$ BEGIN EXECUTE 'GRANT SELECT ON demo_records TO legacy_runtime'; END $body$;",
			'ROLE_UNKNOWN legacy_runtime',
		],
		[
			'a grant after a string holding --',
			"COMMENT ON TABLE demo_records IS 'a -- b'; GRANT SELECT ON demo_records TO legacy_runtime;",
			'ROLE_UNKNOWN legacy_runtime',
		],
		[
			'a differently cased quoted role',
			'GRANT SELECT ON demo_records TO "FLOWDULAR_RUNTIME";',
			'ROLE_UNKNOWN FLOWDULAR_RUNTIME',
		],
	])('reports %s', (_label, statement, issue) => {
		expect(found(`${POLICY}${statement}\n`)).toEqual([issue]);
	});

	it('reports every role a rolname IN list names', () => {
		expect(
			found(
				"SELECT count(*) FROM pg_roles WHERE rolname IN ('legacy_runtime', 'legacy_background');",
			),
		).toEqual([
			'ROLE_UNKNOWN legacy_runtime',
			'ROLE_UNKNOWN legacy_background',
		]);
	});
});
