import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import {
	GREENFIELD_ACCOUNTS,
	runGreenfield,
	seedGreenfield,
} from '../src/cli/greenfield.ts';
import { DatabaseAuthRepository } from '../src/services/database-repository.ts';
import { verifyPassword } from '../src/services/password.ts';

/* Seeding boots an embedded PostgreSQL and hashes two passwords at the real
   cost parameters, which outlasts the default per-test timeout. */

describe('auth greenfield', () => {
	it('previews without touching the local database', async () => {
		const workspaceRoot = await mkdtemp(
			join(tmpdir(), 'flowdular-greenfield-'),
		);
		const dataDirectory = resolve(
			workspaceRoot,
			'.flowdular',
			'data',
			'pglite',
		);
		try {
			const preview = await runGreenfield({
				workspaceRoot,
				moduleRoot: workspaceRoot,
				apply: false,
				flags: new Map(),
				arguments: [],
			});
			expect(preview.data).toMatchObject({
				applied: false,
				database: dataDirectory,
				accounts: {
					admin: { email: GREENFIELD_ACCOUNTS.admin.email },
					user: { email: GREENFIELD_ACCOUNTS.user.email },
				},
			});
			await expect(access(dataDirectory)).rejects.toThrow();
		} finally {
			await rm(workspaceRoot, { recursive: true, force: true });
		}
	});

	it('resets and seeds the demo accounts into the database it is given', async () => {
		const databases = createPgliteTestProvider();
		try {
			await seedGreenfield(databases);
			const runtime = await databases.acquire({
				namespace: 'auth.core',
				purpose: 'runtime',
			});
			const background = await databases.acquire({
				namespace: 'auth.core',
				purpose: 'background',
			});
			try {
				const repository = new DatabaseAuthRepository({
					runtime: runtime.database,
					background: background.database,
				});
				const admin = await repository.findAccountByEmail(
					GREENFIELD_ACCOUNTS.admin.email,
				);
				const user = await repository.findAccountByEmail(
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
					await repository.listTenantAccess(admin?.accountId ?? ''),
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
				await background.release();
				await runtime.release();
			}
		} finally {
			await databases.dispose();
		}
	});
});
