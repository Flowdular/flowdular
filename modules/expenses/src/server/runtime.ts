import { resolve } from 'node:path';
import { ExpensesService } from '../services/expenses-service.ts';
import { SqliteExpensesRepository } from '../services/sqlite-repository.ts';

export interface ExpensesRuntimeOptions {
	readonly databasePath: string;
}

export interface ExpensesRuntime {
	service(): ExpensesService;
}

export function expensesRuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): ExpensesRuntimeOptions {
	return {
		databasePath:
			environment.OERP_EXPENSES_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/expenses.db'
				: resolve(workspaceRoot, '.octane-erp/expenses.db')),
	};
}

export function createExpensesRuntime(
	options: ExpensesRuntimeOptions = expensesRuntimeOptionsFromEnvironment(),
): ExpensesRuntime {
	let service: ExpensesService | undefined;
	return {
		service: () => {
			service ??= new ExpensesService(
				new SqliteExpensesRepository(options.databasePath),
			);
			return service;
		},
	};
}
