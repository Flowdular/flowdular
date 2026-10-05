/* Every migration grants to these names, so they must match
   infra/docker/postgres/10-roles.sh exactly; a rename changes them here. */
export const APPLICATION_ROLES = {
	runtime: 'flowdular_runtime',
	background: 'flowdular_background',
} as const;

export type ApplicationRole = keyof typeof APPLICATION_ROLES;

export interface SqlSession {
	query(
		text: string,
	): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

const roles = Object.keys(APPLICATION_ROLES) as ApplicationRole[];

function literal(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function identifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Reports which application roles already exist. The session must belong to
 * the database owner, which also acts as the migrator: it creates the roles,
 * owns every table the migrations create and grants on them.
 */
export async function inspectApplicationRoles(
	session: SqlSession,
): Promise<Readonly<Record<ApplicationRole, boolean>>> {
	const owner = (
		await session.query(
			`SELECT r.rolsuper OR r.rolcreaterole AS creates_roles,
			        r.rolsuper OR pg_has_role(current_user, d.datdba, 'MEMBER') AS owns_database,
			        has_schema_privilege('public', 'CREATE') AS creates_tables
			   FROM pg_roles r, pg_database d
			  WHERE r.rolname = current_user AND d.datname = current_database()`,
		)
	).rows[0];
	if (
		owner?.creates_roles !== true ||
		owner.owns_database !== true ||
		owner.creates_tables !== true
	) {
		throw new Error(
			'The database URL must belong to the database owner with CREATEROLE and CREATE on schema public, such as the <database>_owner role Neon creates.',
		);
	}
	const existing = new Set<string>();
	for (const row of (
		await session.query(
			`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
			  WHERE rolname IN (${roles.map((role) => literal(APPLICATION_ROLES[role])).join(', ')})`,
		)
	).rows) {
		if (row.rolsuper === true || row.rolbypassrls === true) {
			throw new Error(
				`The existing role ${String(row.rolname)} holds SUPERUSER or BYPASSRLS, so row-level security would not bind it. Remove those attributes or drop the role.`,
			);
		}
		existing.add(String(row.rolname));
	}
	return {
		runtime: existing.has(APPLICATION_ROLES.runtime),
		background: existing.has(APPLICATION_ROLES.background),
	};
}

/**
 * Creates the runtime and background roles, or sets an existing one's password,
 * and gives them what infra/docker/postgres/10-roles.sh gives them, in one
 * transaction. Setting the password even when it should already match keeps a
 * role in step with the caller's record after an earlier run failed between
 * recording a password and committing it.
 */
export async function applyApplicationRoles(
	session: SqlSession,
	passwords: Readonly<Record<ApplicationRole, string>>,
): Promise<void> {
	const database = identifier(
		String(
			(await session.query('SELECT current_database() AS name')).rows[0]?.name,
		),
	);
	const runtime = identifier(APPLICATION_ROLES.runtime);
	const background = identifier(APPLICATION_ROLES.background);
	await session.query('BEGIN');
	try {
		const existing = new Set(
			(
				await session.query(
					`SELECT rolname FROM pg_roles WHERE rolname IN (${roles.map((role) => literal(APPLICATION_ROLES[role])).join(', ')})`,
				)
			).rows.map((row) => String(row.rolname)),
		);
		for (const role of roles) {
			const name = identifier(APPLICATION_ROLES[role]);
			const password = literal(passwords[role]);
			await session.query(
				existing.has(APPLICATION_ROLES[role])
					? `ALTER ROLE ${name} WITH LOGIN PASSWORD ${password}`
					: `CREATE ROLE ${name} LOGIN PASSWORD ${password} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
			);
		}
		for (const statement of [
			`REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC`,
			`GRANT CONNECT ON DATABASE ${database} TO ${runtime}, ${background}`,
			'REVOKE ALL ON SCHEMA public FROM PUBLIC',
			`GRANT USAGE ON SCHEMA public TO ${runtime}, ${background}`,
			/* The background role gets no table grant: each migration grants it the
		   columns its cross-tenant poll reads. */
			`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime}`,
			`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${runtime}`,
		])
			await session.query(statement);
		await session.query('COMMIT');
	} catch (error) {
		await session.query('ROLLBACK').catch(() => undefined);
		throw error;
	}
}
