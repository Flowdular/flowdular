/* WRONG: browser code importing the server repository. */
import type { DatabaseHandle } from '@flowdular/database';
import { DatabaseCustomerRepository } from '../services/database-repository.ts';
import type { Customer } from '../domain/types.ts';

declare const database: DatabaseHandle;

const repository = new DatabaseCustomerRepository(database);

export function loadCustomers(tenantId: string): Promise<readonly Customer[]> {
	return repository.list(tenantId);
}
