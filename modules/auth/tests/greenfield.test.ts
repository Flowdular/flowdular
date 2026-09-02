import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runGreenfield, GREENFIELD_ACCOUNTS } from '../src/cli/greenfield.ts';
import { verifyPassword } from '../src/services/password.ts';
import { SqliteAuthRepository } from '../src/services/sqlite-repository.ts';

describe('auth greenfield', () => {
	it('previews safely, then resets and seeds the local database', async () => {
		const workspaceRoot = await mkdtemp(join(tmpdir(), 'coreloom-greenfield-'));
		const databasePath = join(workspaceRoot, '.coreloom/data/auth.db');
		try {
			const preview = await runGreenfield({
				workspaceRoot,
				moduleRoot: workspaceRoot,
				apply: false,
				flags: new Map(),
				arguments: [],
			});
			expect(preview.data).toMatchObject({ applied: false });
			await expect(access(databasePath)).rejects.toThrow();

			const applied = await runGreenfield({
				workspaceRoot,
				moduleRoot: workspaceRoot,
				apply: true,
				flags: new Map(),
				arguments: [],
			});
			expect(applied.data).toMatchObject({
				applied: true,
				accounts: {
					admin: { email: GREENFIELD_ACCOUNTS.admin.email },
					user: { email: GREENFIELD_ACCOUNTS.user.email },
				},
			});

			const repository = new SqliteAuthRepository(databasePath);
			try {
				const admin = repository.findAccountByEmail(
					GREENFIELD_ACCOUNTS.admin.email,
				);
				const user = repository.findAccountByEmail(
					GREENFIELD_ACCOUNTS.user.email,
				);
				expect(admin?.role).toBe('owner');
				expect(admin?.scopes).toEqual(
					expect.arrayContaining([
						'users.members.manage',
						'parties.records.manage',
						'catalog.items.manage',
					]),
				);
				expect(
					repository.listTenantAccess(admin?.accountId ?? ''),
				).toHaveLength(2);
				expect(user?.role).toBe('member');
				expect(user?.scopes).not.toContain('system.specs.read');
				expect(user?.scopes).not.toContain('system.modules.read');
				expect(user?.scopes).not.toContain('system.specs.read');
				expect(user?.scopes).not.toContain('system.runs.read');
				expect(user?.scopes).toEqual(
					expect.arrayContaining([
						'users.members.read',
						'parties.records.read',
						'catalog.items.read',
					]),
				);
				expect(
					await verifyPassword(
						GREENFIELD_ACCOUNTS.admin.password,
						admin?.passwordHash ?? '',
					),
				).toBe(true);
			} finally {
				repository.close();
			}
		} finally {
			await rm(workspaceRoot, { recursive: true, force: true });
		}
	});
});
