import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { AuthService } from '../src/services/auth-service.ts';
import {
	closeAuthTestDatabases,
	createAuthTestDatabase,
	type AuthTestDatabase,
} from './support/database.ts';

let database: AuthTestDatabase | undefined;

afterEach(async () => {
	await database?.dispose();
	database = undefined;
});

afterAll(closeAuthTestDatabases);

it('checks whether a workspace exists with one bounded routing read', async () => {
	database = await createAuthTestDatabase();
	const service = new AuthService(database.repository);
	const read = vi.spyOn(database.background, 'query');

	expect(await service.hasAnyTenant()).toBe(false);
	await database.runtime.transaction(
		(transaction) =>
			transaction.execute({
				text: `INSERT INTO auth_tenants (id, name, slug, created_at)
				       VALUES ('test-workspace', 'Test Workspace', 'test-workspace', 1)`,
			}),
		{ access: 'write', tenantId: 'test-workspace' },
	);
	expect(await service.hasAnyTenant()).toBe(true);
	expect(read).toHaveBeenCalledTimes(2);
	for (const [statement] of read.mock.calls) {
		expect(statement.text).toMatch(/^SELECT id FROM auth_tenants LIMIT 1$/);
	}
});
