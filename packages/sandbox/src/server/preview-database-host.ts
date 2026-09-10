import {
	DatabaseError,
	type DatabaseAdapterLease,
	type DatabaseCapabilities,
	type DatabaseOperationOptions,
	type DatabaseProvider,
	type DatabaseSession,
	type DatabaseTransaction,
	type DatabaseTransactionOptions,
} from '@flowdular/database';
import {
	isPreviewDatabaseRequest,
	previewDatabaseError,
	previewDatabaseFailure,
	PREVIEW_DATABASE_REPLY,
	type PreviewDatabaseCall,
	type PreviewDatabaseGrant,
	type PreviewDatabaseLeaseRequest,
	type PreviewDatabaseReply,
	type PreviewDatabaseTarget,
	type PreviewDatabaseTransactionOptions,
} from './preview-database-protocol.ts';

export interface PreviewDatabaseHostOptions {
	/** Opens the session engine on the first lease. Never called after close. */
	open(): Promise<DatabaseProvider>;
	send(reply: PreviewDatabaseReply): void;
}

export interface PreviewDatabaseHost {
	/** True when the message belonged to the preview database protocol. */
	accept(message: unknown): boolean;
	/** Idempotent. Rolls every open transaction back, then closes the engine. */
	close(): Promise<void>;
}

interface OpenTransaction {
	/** The pinned session once BEGIN landed. Rejects when it never did. */
	readonly session: Promise<DatabaseTransaction>;
	/** Serialises every operation and the commit. Never rejects. */
	gate: Promise<void>;
	settle(error: Error | null): void;
	readonly finished: Promise<void>;
}

function withoutDialectSql(
	capabilities: DatabaseCapabilities,
): PreviewDatabaseGrant['capabilities'] {
	const { sql: _dialectSql, ...serializable } = capabilities;
	return serializable;
}

function operationOptions(call: {
	readonly timeoutMs?: number;
}): DatabaseOperationOptions {
	return call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs };
}

function transactionOptions(
	options: PreviewDatabaseTransactionOptions,
): DatabaseTransactionOptions {
	return {
		...(options.access === undefined ? {} : { access: options.access }),
		...(options.isolation === undefined
			? {}
			: { isolation: options.isolation }),
		...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
		...operationOptions(options),
	};
}

/**
 * Serves the preview worker's database calls against the real session engine.
 * The worker holds the contract; this side holds the connections, so every
 * transaction it opens is this side's to commit, roll back, or reclaim when the
 * worker dies.
 */
export function createPreviewDatabaseHost(
	options: PreviewDatabaseHostOptions,
): PreviewDatabaseHost {
	const leases = new Map<number, DatabaseAdapterLease>();
	const transactions = new Map<number, OpenTransaction>();
	let provider: Promise<DatabaseProvider> | undefined;
	let closing: Promise<void> | undefined;

	const send = (reply: PreviewDatabaseReply) => {
		try {
			options.send(reply);
		} catch {
			/* The worker went away between its request and this reply. */
		}
	};

	async function grant(
		lease: number,
		request: PreviewDatabaseLeaseRequest,
	): Promise<PreviewDatabaseGrant> {
		provider ??= options.open();
		const acquired = await (await provider).acquire(request);
		if (closing) {
			await acquired.release();
			throw new DatabaseError(
				'ADAPTER_DISPOSED',
				'The preview database host is closed.',
			);
		}
		leases.set(lease, acquired);
		return {
			adapterId: acquired.database.adapterId,
			dialectId: acquired.database.dialectId,
			capabilities: withoutDialectSql(acquired.database.capabilities),
		};
	}

	/* One parent connection is pinned to a transaction, and the worker may
	   abandon a statement whose deadline fired, so the next statement and the
	   commit both wait for the one still in flight. */
	function within<T>(
		id: number,
		run: (transaction: DatabaseTransaction) => Promise<T>,
	): Promise<T> {
		const entry = transactions.get(id);
		if (!entry) {
			throw new DatabaseError(
				'TRANSACTION_CONTEXT_MISUSE',
				'The preview database transaction has already ended.',
			);
		}
		const result = entry.gate.then(() => entry.session).then(run);
		entry.gate = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function onTarget<T>(
		target: PreviewDatabaseTarget,
		run: (session: DatabaseSession) => Promise<T>,
	): Promise<T> {
		if (target.transaction !== undefined)
			return within(target.transaction, run);
		const lease = leases.get(target.lease);
		if (!lease) {
			throw new DatabaseError(
				'ADAPTER_DISPOSED',
				'The preview database lease was released.',
			);
		}
		return run(lease.database);
	}

	async function begin(
		lease: number,
		id: number,
		wanted: PreviewDatabaseTransactionOptions,
	): Promise<undefined> {
		const held = leases.get(lease);
		if (!held) {
			throw new DatabaseError(
				'ADAPTER_DISPOSED',
				'The preview database lease was released.',
			);
		}
		let ready!: (transaction: DatabaseTransaction) => void;
		const pinned = new Promise<DatabaseTransaction>((resolve) => {
			ready = resolve;
		});
		let settle!: (error: Error | null) => void;
		const body = new Promise<void>((resolve, reject) => {
			settle = (error) => (error ? reject(error) : resolve());
		});
		/* A begin that fails leaves nobody inside the callback to observe this. */
		void body.catch(() => undefined);
		const finished = held.database.transaction(async (transaction) => {
			ready(transaction);
			await body;
		}, transactionOptions(wanted));
		/* BEGIN, the tenant context statement, or the options themselves can fail
		   before the callback runs. The gate must then reject rather than leave a
		   settle request waiting forever. */
		const session = Promise.race([
			pinned,
			finished.then(
				() => {
					throw new DatabaseError(
						'TRANSACTION_CONTEXT_MISUSE',
						'The preview database transaction ended before it began.',
					);
				},
				(error: unknown) => {
					throw error;
				},
			),
		]);
		const entry: OpenTransaction = {
			session,
			gate: session.then(
				() => undefined,
				() => undefined,
			),
			settle,
			finished,
		};
		transactions.set(id, entry);
		try {
			await session;
		} catch (error) {
			transactions.delete(id);
			throw error;
		}
		return undefined;
	}

	async function end(id: number, failure: Error | null): Promise<undefined> {
		const entry = transactions.get(id);
		/* An unknown token is the worker cleaning up a begin it never received. */
		if (!entry) return undefined;
		transactions.delete(id);
		const done = entry.gate.then(() => {
			entry.settle(failure);
			return entry.finished;
		});
		entry.gate = done.then(
			() => undefined,
			() => undefined,
		);
		try {
			await done;
		} catch (error) {
			/* A rollback the worker asked for rethrows the failure it already owns. */
			if (!failure) throw error;
		}
		return undefined;
	}

	async function perform(call: PreviewDatabaseCall): Promise<unknown> {
		if (closing) {
			throw new DatabaseError(
				'ADAPTER_DISPOSED',
				'The preview database host is closed.',
			);
		}
		switch (call.kind) {
			case 'acquire':
				return await grant(call.lease, call.request);
			case 'release': {
				const lease = leases.get(call.lease);
				leases.delete(call.lease);
				await lease?.release();
				return undefined;
			}
			case 'begin':
				return await begin(call.lease, call.transaction, call.options);
			case 'settle':
				return await end(
					call.transaction,
					call.error ? previewDatabaseError(call.error) : null,
				);
			case 'migration-lock':
				return await within(call.transaction, (transaction) =>
					transaction.acquireMigrationLock(call.namespace),
				);
			case 'query':
				return await onTarget(call.target, (session) =>
					session.query(call.statement, operationOptions(call)),
				);
			case 'execute':
				return await onTarget(call.target, (session) =>
					session.execute(call.statement, operationOptions(call)),
				);
			case 'script':
				return await onTarget(call.target, (session) =>
					session.executeScript(call.script, operationOptions(call)),
				);
			case 'has-table':
				return await onTarget(call.target, (session) =>
					session.schema.hasTable(call.name, operationOptions(call)),
				);
			case 'has-index':
				return await onTarget(call.target, (session) =>
					session.schema.hasIndex(call.name, operationOptions(call)),
				);
			case 'has-column':
				return await onTarget(call.target, (session) =>
					session.schema.hasColumn(
						call.table,
						call.column,
						operationOptions(call),
					),
				);
		}
	}

	return {
		accept(message: unknown): boolean {
			if (!isPreviewDatabaseRequest(message)) return false;
			const id = message.id;
			void perform(message.call).then(
				(value) => send({ type: PREVIEW_DATABASE_REPLY, id, ok: true, value }),
				(error: unknown) =>
					send({
						type: PREVIEW_DATABASE_REPLY,
						id,
						ok: false,
						error: previewDatabaseFailure(error),
					}),
			);
			return true;
		},
		close(): Promise<void> {
			closing ??= (async () => {
				const open = [...transactions.values()];
				transactions.clear();
				const reason = new DatabaseError(
					'ADAPTER_DISPOSED',
					'The preview worker stopped while the transaction was open.',
				);
				await Promise.allSettled(
					open.map((entry) =>
						entry.gate.then(() => {
							entry.settle(reason);
							return entry.finished;
						}),
					),
				);
				await Promise.allSettled(
					[...leases.values()].map((lease) => lease.release()),
				);
				leases.clear();
				const opened = provider;
				provider = undefined;
				if (!opened) return;
				const engine = await opened.catch(() => undefined);
				await engine?.dispose();
			})();
			return closing;
		},
	};
}
