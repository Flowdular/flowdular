import { coreloomLocalDataPath } from '@coreloom/kernel/legacy-local-state';
import { ExpensesService } from '../services/expenses-service.ts';
import { SqliteExpensesRepository } from '../services/sqlite-repository.ts';

export interface ExpensesRuntimeOptions {
	readonly databasePath: string;
}

export interface ExpensesRuntime {
	service(): ExpensesService;
	dispose(): void;
}

export function expensesRuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): ExpensesRuntimeOptions {
	return {
		databasePath:
			environment.CL_EXPENSES_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/expenses.db'
				: environment.NODE_ENV === 'test'
					? ':memory:'
					: coreloomLocalDataPath(workspaceRoot, 'expenses.db')),
	};
}

export function createExpensesRuntime(
	options: ExpensesRuntimeOptions = expensesRuntimeOptionsFromEnvironment(),
): ExpensesRuntime {
	let service: ExpensesService | undefined;
	let repository: SqliteExpensesRepository | undefined;
	let disposed = false;
	return {
		service: () => {
			if (disposed) throw new Error('Expenses runtime is disposed.');
			repository ??= new SqliteExpensesRepository(options.databasePath);
			service ??= new ExpensesService(repository);
			return service;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			repository?.close();
			repository = undefined;
			service = undefined;
		},
	};
}
