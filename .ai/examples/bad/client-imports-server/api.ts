/* WRONG: browser code importing the server repository. */
import { SqliteCustomerRepository } from '../services/sqlite-repository.ts';
import type { Customer } from '../domain/types.ts';

const repository = new SqliteCustomerRepository('.octane-erp/customers.db');

export function loadCustomers(tenantId: string): readonly Customer[] {
	return repository.list(tenantId);
}
