import { AsyncLocalStorage } from 'node:async_hooks';
import {
	assertNotAborted,
	databaseDialectSql,
	DatabaseError,
	operationSignal,
	type DatabaseAdapterLease,
	type DatabaseCapabilities,
	type DatabaseCommandResult,
	type DatabaseHandle,
	type DatabaseOperationOptions,
	type DatabaseProvider,
	type DatabaseProviderRequest,
	type DatabaseQueryResult,
	type DatabaseRow,
	type DatabaseSchemaIntrospector,
	type DatabaseSession,
	type DatabaseStatement,
	type DatabaseTransaction,
	type DatabaseTransactionOptions,
} from '@flowdular/database';
import {
	isPreviewDatabaseReply,
	previewDatabaseError,
	previewDatabaseFailure,
	PREVIEW_DATABASE_REQUEST,
	type PreviewDatabaseCall,
	type PreviewDatabaseGrant,
	type PreviewDatabaseLeaseRequest,
	type PreviewDatabaseReply,
	type PreviewDatabaseRequest,
	type PreviewDatabaseTarget,
	type PreviewDatabaseTransactionOptions,
} from './preview-database-protocol.ts';

export interface PreviewDatabasePort {
	send(request: PreviewDatabaseRequest): void;
	/** Every message the host puts on the channel, database or not. */
	subscribe(listener: (message: unknown) => void): void;
}

interface LeaseMetadata {
	readonly adapterId: string;
	readonly dialectId: string;
	readonly capabilities: DatabaseCapabilities;
}

function deadline(options: DatabaseOperationOptions): {
	readonly timeoutMs?: number;
} {
	return options.timeoutMs === undefined
		? {}
		: { timeoutMs: options.timeoutMs };
}

function combinedSignal(
	base: AbortSignal | undefined,
	options: DatabaseOperationOptions,
): AbortSignal | undefined {
	const current = operationSignal(options);
	return base && current ? AbortSignal.any([base, current]) : (base ?? current);
}

function leaseRequest(
	request: DatabaseProviderRequest,
): PreviewDatabaseLeaseRequest {
	return {
		namespace: request.namespace,
		purpose: request.purpose,
		...(request.requirements === undefined
			? {}
			: { requirements: request.requirements }),
		...deadline(request),
	};
}

function transactionOptions(
	options: DatabaseTransactionOptions,
): PreviewDatabaseTransactionOptions {
	return {
		...(options.access === undefined ? {} : { access: options.access }),
		...(options.isolation === undefined
			? {}
			: { isolation: options.isolation }),
		...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
		...deadline(options),
	};
}

/**
 * A database provider that satisfies the ordinary contract while its engine
 * lives in the parent process. Draft module code never learns it is remote.
 */
export function createRemoteDatabaseProvider(
	port: PreviewDatabasePort,
): DatabaseProvider {
	const pending = new Map<number, (reply: PreviewDatabaseReply) => void>();
	const leases = new Set<number>();
	/* A transaction callback runs here while its connection stays pinned in the
	   parent, which cannot see this callback at all. The root handle is refused
	   locally instead: the embedded engine is a single connection, so a root
	   operation would queue behind the transaction that is waiting for it. */
	const inTransaction = new AsyncLocalStorage<true>();
	let requests = 0;
	let resources = 0;
	let disposed = false;

	port.subscribe((message) => {
		if (!isPreviewDatabaseReply(message)) return;
		const settle = pending.get(message.id);
		if (!settle) return;
		pending.delete(message.id);
		settle(message);
	});

	async function call<T>(
		payload: PreviewDatabaseCall,
		signal?: AbortSignal,
	): Promise<T> {
		assertNotAborted(signal);
		const id = ++requests;
		return await new Promise<T>((resolve, reject) => {
			/* The parent keeps working on a request whose local deadline fired.
			   Dropping the entry frees the caller; the reply is discarded. */
			const abandon = () => {
				if (!pending.delete(id)) return;
				reject(
					new DatabaseError(
						'OPERATION_ABORTED',
						'Database operation was aborted.',
						{ cause: signal?.reason },
					),
				);
			};
			pending.set(id, (reply) => {
				signal?.removeEventListener('abort', abandon);
				if (reply.ok) resolve(reply.value as T);
				else reject(previewDatabaseError(reply.error));
			});
			signal?.addEventListener('abort', abandon, { once: true });
			try {
				port.send({ type: PREVIEW_DATABASE_REQUEST, id, call: payload });
			} catch (cause) {
				pending.delete(id);
				signal?.removeEventListener('abort', abandon);
				reject(
					new DatabaseError(
						'ADAPTER_DISPOSED',
						'The preview database channel is closed.',
						{ cause },
					),
				);
			}
		});
	}

	function remoteSession(
		target: PreviewDatabaseTarget,
		metadata: LeaseMetadata,
		base: AbortSignal | undefined,
		guard: () => void,
	): DatabaseSession {
		const schema: DatabaseSchemaIntrospector = {
			async hasTable(name, options = {}) {
				guard();
				return await call<boolean>(
					{ kind: 'has-table', target, name, ...deadline(options) },
					combinedSignal(base, options),
				);
			},
			async hasColumn(table, column, options = {}) {
				guard();
				return await call<boolean>(
					{ kind: 'has-column', target, table, column, ...deadline(options) },
					combinedSignal(base, options),
				);
			},
			async hasIndex(name, options = {}) {
				guard();
				return await call<boolean>(
					{ kind: 'has-index', target, name, ...deadline(options) },
					combinedSignal(base, options),
				);
			},
		};
		return {
			adapterId: metadata.adapterId,
			dialectId: metadata.dialectId,
			capabilities: metadata.capabilities,
			schema,
			async query<Row extends DatabaseRow = DatabaseRow>(
				statement: DatabaseStatement,
				options: DatabaseOperationOptions = {},
			): Promise<DatabaseQueryResult<Row>> {
				guard();
				return await call<DatabaseQueryResult<Row>>(
					{ kind: 'query', target, statement, ...deadline(options) },
					combinedSignal(base, options),
				);
			},
			async execute(
				statement: DatabaseStatement,
				options: DatabaseOperationOptions = {},
			): Promise<DatabaseCommandResult> {
				guard();
				return await call<DatabaseCommandResult>(
					{ kind: 'execute', target, statement, ...deadline(options) },
					combinedSignal(base, options),
				);
			},
			async executeScript(
				script: string,
				options: DatabaseOperationOptions = {},
			): Promise<void> {
				guard();
				await call<undefined>(
					{ kind: 'script', target, script, ...deadline(options) },
					combinedSignal(base, options),
				);
			},
		};
	}

	function remoteHandle(
		lease: number,
		metadata: LeaseMetadata,
	): DatabaseHandle {
		const assertRoot = () => {
			if (!inTransaction.getStore()) return;
			throw new DatabaseError(
				'TRANSACTION_CONTEXT_MISUSE',
				'Use the transaction argument inside a transaction callback.',
			);
		};
		return {
			...remoteSession({ lease }, metadata, undefined, assertRoot),
			async transaction<T>(
				operation: (transaction: DatabaseTransaction) => Promise<T>,
				options: DatabaseTransactionOptions = {},
			): Promise<T> {
				assertRoot();
				const signal = operationSignal(options);
				const transaction = ++resources;
				try {
					await call<undefined>(
						{
							kind: 'begin',
							lease,
							transaction,
							options: transactionOptions(options),
						},
						signal,
					);
				} catch (error) {
					/* A begin whose local deadline fired may still have pinned the
					   parent connection, so the rollback is asked for by token. */
					void call<undefined>({
						kind: 'settle',
						transaction,
						error: previewDatabaseFailure(error),
					}).catch(() => undefined);
					throw error;
				}
				let active = true;
				const guard = () => {
					if (active) return;
					throw new DatabaseError(
						'TRANSACTION_CONTEXT_MISUSE',
						'The preview database transaction callback has already ended.',
					);
				};
				const pinned: DatabaseTransaction = {
					...remoteSession({ lease, transaction }, metadata, signal, guard),
					async acquireMigrationLock(namespace: string): Promise<void> {
						guard();
						await call<undefined>(
							{ kind: 'migration-lock', transaction, namespace },
							signal,
						);
					},
				};
				let value: T;
				try {
					value = await inTransaction.run(true, () => operation(pinned));
				} catch (error) {
					active = false;
					/* The settle carries no signal: an aborted transaction still has
					   to reach the parent, which is holding the connection open. */
					await call<undefined>({
						kind: 'settle',
						transaction,
						error: previewDatabaseFailure(error),
					}).catch(() => undefined);
					throw error;
				}
				active = false;
				await call<undefined>({ kind: 'settle', transaction, error: null });
				return value;
			},
		};
	}

	return {
		async acquire(
			request: DatabaseProviderRequest,
		): Promise<DatabaseAdapterLease> {
			if (disposed) {
				throw new DatabaseError(
					'ADAPTER_DISPOSED',
					'The preview database provider is not accepting leases.',
				);
			}
			const signal = operationSignal(request);
			const lease = ++resources;
			let granted: PreviewDatabaseGrant;
			try {
				granted = await call<PreviewDatabaseGrant>(
					{ kind: 'acquire', lease, request: leaseRequest(request) },
					signal,
				);
			} catch (error) {
				void call<undefined>({ kind: 'release', lease }).catch(() => undefined);
				throw error;
			}
			leases.add(lease);
			const metadata: LeaseMetadata = {
				adapterId: granted.adapterId,
				dialectId: granted.dialectId,
				capabilities: Object.freeze({
					...granted.capabilities,
					sql: databaseDialectSql(granted.dialectId),
				}),
			};
			const database = remoteHandle(lease, metadata);
			let released = false;
			return {
				database,
				async release(): Promise<void> {
					if (released) return;
					released = true;
					leases.delete(lease);
					await call<undefined>({ kind: 'release', lease });
				},
			};
		},
		async dispose(): Promise<void> {
			if (disposed) return;
			disposed = true;
			const open = [...leases];
			leases.clear();
			await Promise.allSettled(
				open.map((lease) => call<undefined>({ kind: 'release', lease })),
			);
		},
	};
}
