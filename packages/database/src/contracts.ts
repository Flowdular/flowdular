export type DatabaseAdapterId = string;
export type DatabaseDialectId = string;
export type DatabaseCapabilityId = string;

export const DATABASE_ADAPTER_IDS = Object.freeze({
	postgresql: 'flowdular.postgresql',
} as const);

export const DATABASE_DIALECT_IDS = Object.freeze({
	postgresql: 'postgresql',
} as const);

export const DATABASE_CAPABILITY_IDS = Object.freeze({
	MIGRATION_LOCK: 'flowdular.database.migration-lock',
	RETURNING: 'flowdular.database.returning',
	ROW_LEVEL_SECURITY: 'flowdular.database.row-level-security',
	SCHEMA_INTROSPECTION: 'flowdular.database.schema-introspection',
	TENANT_CONTEXT: 'flowdular.database.tenant-context',
	TRANSACTIONAL_DDL: 'flowdular.database.transactional-ddl',
	TRANSACTIONS: 'flowdular.database.transactions',
} as const);

export type DatabaseParameter = Uint8Array | bigint | number | string | null;

export type DatabaseRow = object;

export interface DatabaseStatement {
	readonly text: string;
	readonly parameters?: readonly DatabaseParameter[];
}

export interface DatabaseOperationOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface DatabaseQueryResult<Row extends DatabaseRow = DatabaseRow> {
	readonly rows: readonly Row[];
	readonly rowCount: number;
}

export interface DatabaseCommandResult {
	readonly affectedRows: number;
	readonly lastInsertId?: number | bigint;
}

export type DatabaseIsolationLevel =
	| 'read-committed'
	| 'repeatable-read'
	| 'serializable';

export interface DatabaseTransactionOptions extends DatabaseOperationOptions {
	readonly access?: 'read' | 'write';
	readonly isolation?: DatabaseIsolationLevel;
	/** Required by PostgreSQL runtime handles before tenant-owned SQL can run. */
	readonly tenantId?: string;
}

export interface DatabaseCapabilities {
	/** Open feature ids used for provider-side requirement negotiation. */
	readonly features: readonly DatabaseCapabilityId[];
	readonly parameterStyle: string;
	readonly migrationLock: string;
	readonly transactionalDdl: boolean;
	readonly returning: boolean;
	readonly isolationLevels: readonly DatabaseIsolationLevel[];
	/** `driver` means the supplied driver actively cancels an in-flight query. */
	readonly cancellation: string;
	readonly schemaIntrospection: true;
	readonly tenantIsolation: string;
	readonly rootOperations: string;
	/** Dialect-owned SQL used by generic infrastructure such as migrations. */
	readonly sql: {
		placeholder(position: number): string;
		migrationLedgerDdl(table: string): string;
	};
}

export interface DatabaseRequirements {
	readonly adapterIds?: readonly DatabaseAdapterId[];
	readonly dialectIds?: readonly DatabaseDialectId[];
	readonly capabilities?: readonly DatabaseCapabilityId[];
	readonly isolationLevels?: readonly DatabaseIsolationLevel[];
}

export interface DatabaseRequirementCandidate {
	readonly adapterId: DatabaseAdapterId;
	readonly dialectId: DatabaseDialectId;
	readonly capabilities: Pick<
		DatabaseCapabilities,
		'features' | 'isolationLevels'
	>;
}

export type DatabaseAdapterState = 'ready' | 'disposing' | 'disposed';

export interface DatabaseSchemaIntrospector {
	hasTable(name: string, options?: DatabaseOperationOptions): Promise<boolean>;
	hasColumn(
		table: string,
		column: string,
		options?: DatabaseOperationOptions,
	): Promise<boolean>;
	hasIndex(name: string, options?: DatabaseOperationOptions): Promise<boolean>;
}

/** A session is valid only for the duration of the transaction callback. */
export interface DatabaseSession {
	readonly adapterId: DatabaseAdapterId;
	readonly dialectId: DatabaseDialectId;
	readonly capabilities: DatabaseCapabilities;
	readonly schema: DatabaseSchemaIntrospector;
	query<Row extends DatabaseRow = DatabaseRow>(
		statement: DatabaseStatement,
		options?: DatabaseOperationOptions,
	): Promise<DatabaseQueryResult<Row>>;
	execute(
		statement: DatabaseStatement,
		options?: DatabaseOperationOptions,
	): Promise<DatabaseCommandResult>;
	/** Executes trusted, checked-in DDL. Never pass request data to this method. */
	executeScript(
		script: string,
		options?: DatabaseOperationOptions,
	): Promise<void>;
}

export interface DatabaseTransaction extends DatabaseSession {
	/** Serializes migration runners for this namespace until the transaction ends. */
	acquireMigrationLock(namespace: string): Promise<void>;
}

export interface DatabaseHandle extends DatabaseSession {
	readonly capabilities: DatabaseCapabilities;
	transaction<T>(
		operation: (transaction: DatabaseTransaction) => Promise<T>,
		options?: DatabaseTransactionOptions,
	): Promise<T>;
}

export interface DatabaseAdapter extends DatabaseHandle {
	readonly state: DatabaseAdapterState;
	/** Idempotent. Waits for work already accepted by the adapter. */
	dispose(): Promise<void>;
}

export interface DatabaseAdapterLease {
	readonly database: DatabaseHandle;
	/** Idempotent. A module releases only its lease, never shared provider state. */
	release(): Promise<void>;
}

export interface DatabaseProviderRequest extends DatabaseOperationOptions {
	readonly namespace: string;
	/**
	 * `runtime`, `preview` and `test` are tenant scoped. `migration` owns the
	 * schema. `background` serves the few platform operations that must read
	 * across tenants, such as a scheduler poll or run recovery after a restart;
	 * it reads only what an explicit `FOR SELECT` policy grants it and writes
	 * nothing, so the follow-up write still takes a tenant-scoped lease.
	 */
	readonly purpose: 'background' | 'migration' | 'preview' | 'runtime' | 'test';
	readonly requirements?: DatabaseRequirements;
}

/** Platform-owned seam. Modules receive this provider, never a DSN or pool. */
export interface DatabaseProvider {
	acquire(request: DatabaseProviderRequest): Promise<DatabaseAdapterLease>;
	/** Idempotent. Refuses new leases, drains them, then closes owned adapters. */
	dispose(): Promise<void>;
}

export type DatabaseErrorCode =
	| 'ADAPTER_DISPOSED'
	| 'INVALID_ARGUMENT'
	| 'OPERATION_ABORTED'
	| 'TENANT_CONTEXT_REQUIRED'
	| 'TRANSACTION_CONTEXT_MISUSE'
	| 'UNSUPPORTED_CAPABILITY';

export class DatabaseError extends Error {
	constructor(
		readonly code: DatabaseErrorCode,
		message: string,
		options?: { readonly cause?: unknown },
	) {
		super(message, options);
		this.name = 'DatabaseError';
	}
}

export function assertStatement(statement: DatabaseStatement): void {
	if (statement.text.trim().length === 0) {
		throw new DatabaseError('INVALID_ARGUMENT', 'SQL text cannot be empty.');
	}
	for (const parameter of statement.parameters ?? []) {
		if (typeof parameter === 'number' && !Number.isFinite(parameter)) {
			throw new DatabaseError(
				'INVALID_ARGUMENT',
				'Database parameters cannot contain a non-finite number.',
			);
		}
	}
}

export function assertNamespace(namespace: string): void {
	if (!/^[a-z][a-z0-9.-]{0,127}$/.test(namespace)) {
		throw new DatabaseError(
			'INVALID_ARGUMENT',
			`"${namespace}" is not a valid database namespace.`,
		);
	}
}

export function assertDatabaseId(
	id: string,
	kind: 'adapter' | 'capability' | 'dialect',
): void {
	if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(id)) {
		throw new DatabaseError(
			'INVALID_ARGUMENT',
			`"${id}" is not a valid database ${kind} id.`,
		);
	}
}

export function unmetDatabaseRequirements(
	database: DatabaseRequirementCandidate,
	requirements: DatabaseRequirements = {},
): readonly string[] {
	assertDatabaseId(database.adapterId, 'adapter');
	assertDatabaseId(database.dialectId, 'dialect');
	for (const capability of database.capabilities.features) {
		assertDatabaseId(capability, 'capability');
	}
	const missing: string[] = [];
	if (
		requirements.adapterIds?.length &&
		!requirements.adapterIds.includes(database.adapterId)
	) {
		missing.push(`adapter:${database.adapterId}`);
	}
	if (
		requirements.dialectIds?.length &&
		!requirements.dialectIds.includes(database.dialectId)
	) {
		missing.push(`dialect:${database.dialectId}`);
	}
	const features = new Set(database.capabilities.features);
	for (const capability of requirements.capabilities ?? []) {
		assertDatabaseId(capability, 'capability');
		if (!features.has(capability)) missing.push(`capability:${capability}`);
	}
	for (const isolation of requirements.isolationLevels ?? []) {
		if (!database.capabilities.isolationLevels.includes(isolation)) {
			missing.push(`isolation:${isolation}`);
		}
	}
	return missing;
}

export function assertDatabaseRequirements(
	database: DatabaseRequirementCandidate,
	requirements: DatabaseRequirements = {},
): void {
	const unmet = unmetDatabaseRequirements(database, requirements);
	if (unmet.length === 0) return;
	throw new DatabaseError(
		'UNSUPPORTED_CAPABILITY',
		`Database requirements are not met: ${unmet.join(', ')}.`,
	);
}

export function assertTenantId(tenantId: string): void {
	if (
		tenantId.length < 1 ||
		tenantId.length > 128 ||
		tenantId.includes('\0') ||
		tenantId.trim() !== tenantId
	) {
		throw new DatabaseError(
			'INVALID_ARGUMENT',
			'Tenant ids must contain 1 to 128 non-NUL characters without surrounding whitespace.',
		);
	}
}

export function assertSchemaName(name: string): void {
	if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
		throw new DatabaseError(
			'INVALID_ARGUMENT',
			`"${name}" is not a valid database schema object name.`,
		);
	}
}

export function operationSignal(
	options: DatabaseOperationOptions = {},
): AbortSignal | undefined {
	if (
		options.timeoutMs !== undefined &&
		(!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
	) {
		throw new DatabaseError(
			'INVALID_ARGUMENT',
			'Database timeouts must be positive integer milliseconds.',
		);
	}
	const timeout =
		options.timeoutMs === undefined
			? undefined
			: AbortSignal.timeout(options.timeoutMs);
	if (options.signal && timeout)
		return AbortSignal.any([options.signal, timeout]);
	return options.signal ?? timeout;
}

export function assertNotAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	throw new DatabaseError(
		'OPERATION_ABORTED',
		'Database operation was aborted.',
		{ cause: signal.reason },
	);
}

export function databasePlaceholder(
	dialectId: DatabaseDialectId,
	position: number,
): string {
	assertDatabaseId(dialectId, 'dialect');
	if (!Number.isSafeInteger(position) || position < 1) {
		throw new DatabaseError(
			'INVALID_ARGUMENT',
			'Database placeholder positions start at 1.',
		);
	}
	if (dialectId === DATABASE_DIALECT_IDS.postgresql) return `$${position}`;
	throw new DatabaseError(
		'UNSUPPORTED_CAPABILITY',
		`The well-known placeholder helper does not support dialect "${dialectId}".`,
	);
}

/**
 * The `sql` half of a capability set, keyed by dialect alone. A handle that
 * reaches its adapter across a process boundary cannot receive these functions,
 * so it rebuilds them here instead of restating the dialect's own SQL.
 */
export function databaseDialectSql(
	dialectId: DatabaseDialectId,
): DatabaseCapabilities['sql'] {
	assertDatabaseId(dialectId, 'dialect');
	const ledger =
		dialectId === DATABASE_DIALECT_IDS.postgresql
			? { appliedAt: 'BIGINT', suffix: '' }
			: undefined;
	if (!ledger) {
		throw new DatabaseError(
			'UNSUPPORTED_CAPABILITY',
			`The well-known dialect SQL helper does not support dialect "${dialectId}".`,
		);
	}
	return Object.freeze({
		placeholder: (position: number) => databasePlaceholder(dialectId, position),
		migrationLedgerDdl: (table: string) => {
			assertSchemaName(table);
			return `CREATE TABLE IF NOT EXISTS ${table} (
	namespace TEXT NOT NULL,
	id TEXT NOT NULL,
	dialect TEXT NOT NULL,
	checksum TEXT NOT NULL,
	applied_at ${ledger.appliedAt} NOT NULL,
	PRIMARY KEY (namespace, id)
)${ledger.suffix};
-- Default application grants must never make the checksum ledger writable.
-- Revoke existing grants as well, so databases created before this rule heal.
DO $ledger_privileges$
DECLARE
	granted_role RECORD;
BEGIN
	FOR granted_role IN
		SELECT DISTINCT acl.grantee, roles.rolname
		FROM pg_class AS relation
		CROSS JOIN LATERAL aclexplode(relation.relacl) AS acl
		LEFT JOIN pg_roles AS roles ON roles.oid = acl.grantee
		WHERE relation.oid = '${table}'::regclass
		  AND acl.grantee <> relation.relowner
	LOOP
		EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM %s',
			'${table}'::regclass,
			CASE WHEN granted_role.grantee = 0 THEN 'PUBLIC'
				ELSE quote_ident(granted_role.rolname) END);
	END LOOP;
END
$ledger_privileges$;`;
		},
	});
}
