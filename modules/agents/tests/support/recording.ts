import type {
	DatabaseHandle,
	DatabaseProvider,
	DatabaseStatement,
	DatabaseTransaction,
	DatabaseTransactionOptions,
} from '@flowdular/database';

export interface RecordedStatement {
	readonly purpose: string;
	/* The transaction's tenant, or undefined outside a tenant transaction. */
	readonly tenantId: string | undefined;
	readonly access: 'read' | 'write' | undefined;
	/* Numbers each transaction, so a case can tell two statements shared one. */
	readonly transaction: number | undefined;
	readonly text: string;
	readonly parameters: readonly unknown[];
}

export interface RecordingProvider {
	readonly provider: DatabaseProvider;
	readonly statements: RecordedStatement[];
}

export interface RecordingHooks {
	/* Runs before a statement reaches the database, inside its transaction, so
	   a case can hold one transaction at a chosen point while another runs. */
	readonly beforeStatement?: (
		statement: RecordedStatement,
	) => Promise<void> | void;
	/* Runs after a transaction commits and before its caller resumes. */
	readonly afterTransaction?: (
		purpose: string,
		options: DatabaseTransactionOptions | undefined,
	) => Promise<void> | void;
}

/* Methods are bound to the real object, whose private fields a proxy receiver
   could not reach. */
function forwarding<T extends object>(
	target: T,
	overrides: Partial<Record<keyof T, unknown>>,
): T {
	return new Proxy(target, {
		get(object, property) {
			if (property in overrides) {
				return overrides[property as keyof T];
			}
			const value = Reflect.get(object, property, object) as unknown;
			return typeof value === 'function' ? value.bind(object) : value;
		},
	});
}

let transactions = 0;

/* Records every statement each lease runs, with the purpose of the lease and
   the tenant and access of the transaction it ran in, so a case can prove what
   an opening, a request or a pass touched. */
export function recordingProvider(
	inner: DatabaseProvider,
	hooks: RecordingHooks = {},
): RecordingProvider {
	const statements: RecordedStatement[] = [];
	const session = <S extends DatabaseTransaction | DatabaseHandle>(
		target: S,
		purpose: string,
		options: DatabaseTransactionOptions | undefined,
		transaction: number | undefined,
	): S => {
		const record = async (statement: DatabaseStatement) => {
			const recorded: RecordedStatement = {
				purpose,
				tenantId: options?.tenantId,
				access: options?.access,
				transaction,
				text: statement.text.replace(/\s+/g, ' ').trim(),
				parameters: statement.parameters ?? [],
			};
			statements.push(recorded);
			await hooks.beforeStatement?.(recorded);
		};
		return forwarding(target, {
			query: async (statement: DatabaseStatement, ...rest: unknown[]) => {
				await record(statement);
				return (target.query as (...args: unknown[]) => unknown)(
					statement,
					...rest,
				);
			},
			execute: async (statement: DatabaseStatement, ...rest: unknown[]) => {
				await record(statement);
				return (target.execute as (...args: unknown[]) => unknown)(
					statement,
					...rest,
				);
			},
		} as Partial<Record<keyof S, unknown>>);
	};
	return {
		statements,
		provider: forwarding(inner, {
			acquire: async (request: Parameters<DatabaseProvider['acquire']>[0]) => {
				const lease = await inner.acquire(request);
				const handle = session(
					lease.database,
					request.purpose,
					undefined,
					undefined,
				);
				return {
					release: () => lease.release(),
					database: forwarding(handle, {
						transaction: async <T>(
							operation: (transaction: DatabaseTransaction) => Promise<T>,
							options?: DatabaseTransactionOptions,
						) => {
							const result = await lease.database.transaction(
								(transaction) =>
									operation(
										session(
											transaction,
											request.purpose,
											options,
											(transactions += 1),
										),
									),
								options,
							);
							await hooks.afterTransaction?.(request.purpose, options);
							return result;
						},
					} as Partial<Record<keyof DatabaseHandle, unknown>>),
				};
			},
		} as Partial<Record<keyof DatabaseProvider, unknown>>),
	};
}
