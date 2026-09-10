import {
	assertNotAborted,
	assertSchemaName,
	DATABASE_DIALECT_IDS,
	DatabaseError,
	operationSignal,
	type DatabaseDialectId,
	type DatabaseHandle,
	type DatabaseOperationOptions,
} from './contracts.ts';

/** Named so a reset can never be reached by an accidental call. */
export interface DatabaseResetAuthorization {
	readonly intent: 'confirmed-destructive-reset';
}

export interface DatabaseResetResult {
	readonly dialectId: DatabaseDialectId;
	/** Catalog order. Empty when the database held no table. */
	readonly droppedTables: readonly string[];
}

const TABLE_QUERY: Readonly<Record<string, string>> = Object.freeze({
	[DATABASE_DIALECT_IDS.postgresql]: `SELECT tablename AS name FROM pg_tables
	       WHERE schemaname = current_schema()
	       ORDER BY tablename`,
});

function tableQuery(dialectId: DatabaseDialectId): string {
	const text = TABLE_QUERY[dialectId];
	if (text) return text;
	throw new DatabaseError(
		'UNSUPPORTED_CAPABILITY',
		`Resetting a database is not implemented for dialect "${dialectId}".`,
	);
}

/**
 * Every table the handle can see, in the order a reset would drop them. A
 * runtime handle that requires tenant context refuses this, so only a
 * migration lease can plan or run a reset.
 */
export async function databaseResetPlan(
	database: DatabaseHandle,
	options: DatabaseOperationOptions = {},
): Promise<readonly string[]> {
	const result = await database.query<{ name: string }>(
		{ text: tableQuery(database.dialectId) },
		options,
	);
	const names = result.rows.map((row) => row.name);
	for (const name of names) assertSchemaName(name);
	return names;
}

/**
 * Drops every table the handle can see, including the migration ledger, so the
 * next start migrates from zero. Data is not recoverable afterwards.
 */
export async function resetDatabase(
	database: DatabaseHandle,
	authorization: DatabaseResetAuthorization,
	options: DatabaseOperationOptions = {},
): Promise<DatabaseResetResult> {
	if (authorization.intent !== 'confirmed-destructive-reset') {
		throw new DatabaseError(
			'INVALID_ARGUMENT',
			'Resetting a database requires an explicit confirmed intent.',
		);
	}
	const signal = operationSignal(options);
	assertNotAborted(signal);
	const dialectId = database.dialectId;
	const tables = await databaseResetPlan(database, options);
	if (tables.length === 0) return { dialectId, droppedTables: [] };
	const quoted = tables.map((name) => `"${name}"`);
	/* CASCADE rather than a dependency sort: the catalog order is not one, and
	   a reset drops the whole module schema anyway. */
	await database.transaction(
		(transaction) =>
			transaction.executeScript(
				`DROP TABLE IF EXISTS ${quoted.join(', ')} CASCADE;`,
			),
		{ ...options, access: 'write' },
	);
	return { dialectId, droppedTables: tables };
}
