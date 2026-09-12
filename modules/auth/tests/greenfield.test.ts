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
						'agents.definitions.manage',
						'sandbox.access.manage',
						'notifications.webhooks.manage',
						'notifications.deliveries.read',
						'directory.tokens.manage',
						'audit.retention.manage',
						'approvals.requests.manage',
						'documents.files.manage',
						'metering.usage.read',
						'import.jobs.manage',
						'search.records.read',
						'connectors.instances.manage',
						'workflows.definitions.publish',
						'workflows.runs.execute',
						'automations.schedules.manage',
						'automations.triggers.manage',
						'profile.self.manage',
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
				expect(admin?.scopes).not.toContain('parties.records.manage');
				expect(admin?.scopes).not.toContain('catalog.items.manage');
				expect(user?.scopes).not.toContain('notifications.webhooks.manage');
				expect(user?.scopes).not.toContain('notifications.deliveries.read');
				expect(user?.scopes).not.toContain('directory.tokens.read');
				expect(user?.scopes).not.toContain('audit.registry.read');
				expect(user?.scopes).not.toContain('approvals.requests.manage');
				expect(user?.scopes).not.toContain('metering.usage.read');
				expect(user?.scopes).not.toContain('import.jobs.read');
				expect(user?.scopes).not.toContain('connectors.instances.manage');
				expect(user?.scopes).not.toContain('workflows.definitions.read');
				expect(user?.scopes).not.toContain('automations.schedules.read');
				expect(user?.scopes).toEqual(
					expect.arrayContaining([
						'users.members.read',
						'agents.definitions.read',
						'agents.skills.read',
						'notifications.inbox.read',
						'notifications.inbox.manage',
						'notifications.webhooks.read',
						'documents.files.read',
						'documents.files.manage',
						'search.records.read',
						'connectors.instances.read',
						'approvals.requests.read',
						'approvals.requests.decide',
						'profile.self.manage',
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
