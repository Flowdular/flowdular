import type { ModuleManifest, RegisteredModule } from '@coreloom/contracts';
import manifest from '../module.json' with { type: 'json' };
import { EXPENSES_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'expenses.navigation',
			label: 'Expense Claims',
			href: '/expenses',
			order: 50,
			permission: EXPENSES_PERMISSIONS.read,
		},
	],
	permissions: Object.values(EXPENSES_PERMISSIONS),
} satisfies RegisteredModule;

export { EXPENSES_PERMISSIONS } from './acl/permissions.ts';
export {
	ExpensesService,
	ExpensesServiceError,
} from './services/expenses-service.ts';
export type {
	CreateExpensesClaimInput,
	ExpenseClaimCategory,
	ExpenseClaimDecision,
	ExpenseClaimStatus,
	ExpensesClaim,
	UpdateExpensesClaimInput,
} from './domain/types.ts';
export {
	EXPENSE_CLAIM_CATEGORIES,
	EXPENSE_CLAIM_STATUSES,
} from './domain/types.ts';
