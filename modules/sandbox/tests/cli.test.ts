import type { DatabaseProvider } from '@flowdular/database';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
} from '@flowdular/module-auth/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliExtension } from '../src/cli/index.ts';
import {
	closeSandboxTestDatabases,
	createSandboxTestDatabase,
	sandboxTestProvider,
} from './support/database.ts';

const OPERATOR = 'cli:test';

let databases: DatabaseProvider;
let target: string;
let impostor: string;
let outside: string;
let ada: string;

/* Ada owns a workspace whose slug spells the id of the workspace she joined
   later, so her memberships list the impostor first. Bob owns one whose slug
   spells the id of a workspace he never joined. */
beforeAll(async () => {
	databases = await sandboxTestProvider();
	const auth = createAuthRuntime({
		...authRuntimeOptionsFromEnvironment(process.env, process.cwd()),
		databases,
	});
	try {
		const service = await auth.service();
		const workspace = async (slug: string, ownerEmail: string) =>
			(
				await service.provisionWorkspace({
					name: `Workspace ${ownerEmail}`,
					slug,
					ownerEmail,
					ownerDisplayName: 'Ada Owner',
					operator: OPERATOR,
				})
			).workspace.tenantId;
		target = await workspace('target', 'tara@target.example');
		impostor = await workspace(target, 'ada@example.test');
		await new Promise((resolve) => setTimeout(resolve, 5));
		await service.provisionMember({
			workspace: target,
			email: 'ada@example.test',
			role: 'member',
			operator: OPERATOR,
		});
		outside = await workspace('outside', 'uma@outside.example');
		await workspace(outside, 'bob@example.test');

		const access = await service.findAccountAccess('ada@example.test');
		expect(access?.tenants.map((tenant) => tenant.tenantId)).toEqual([
			impostor,
			target,
		]);
		ada = access!.accountId;
	} finally {
		await auth.dispose();
	}
});

afterAll(closeSandboxTestDatabases);

function plan(capability: string, email: string, tenant: string) {
	const command = cliExtension.commands.find(
		(entry) => entry.capability.id === capability,
	)!;
	return command.execute({
		workspaceRoot: process.cwd(),
		moduleRoot: process.cwd(),
		apply: false,
		flags: new Map([
			['email', email],
			['tenant', tenant],
		]),
		arguments: [],
		databases,
	});
}

const grantPlan = (email: string, tenant: string) =>
	plan('sandbox.access.grant', email, tenant);

describe('SANDBOX-GRANT-DRY-RUN --tenant reference', () => {
	it('resolves an id to that workspace even when an earlier membership took the id as its slug', async () => {
		const plan = await grantPlan('ada@example.test', target);

		expect(plan.data).toMatchObject({
			applied: false,
			tenant: { tenantId: target, slug: 'target' },
		});
	});

	it('refuses an id of a workspace the account never joined, even when one of its workspaces took the id as its slug', async () => {
		await expect(grantPlan('bob@example.test', outside)).rejects.toThrow(
			`bob@example.test is not a member of "${outside}".`,
		);
	});

	it('names the reference when an account in several workspaces is not a member of it', async () => {
		await expect(grantPlan('ada@example.test', outside)).rejects.toThrow(
			`ada@example.test is not a member of "${outside}".`,
		);
	});

	it('still resolves a slug in any case', async () => {
		const plan = await grantPlan('ada@example.test', 'TARGET');

		expect(plan.data).toMatchObject({ tenant: { tenantId: target } });
	});
});

describe('SANDBOX-REVOKE --tenant reference', () => {
	it('revokes in the workspace an id names even when an earlier membership took the id as its slug', async () => {
		const { repository, dispose } = await createSandboxTestDatabase();
		try {
			for (const tenantId of [impostor, target]) {
				await repository.saveGrant({
					id: `grant-${tenantId}`,
					tenantId,
					accountId: ada,
					email: 'ada@example.test',
					displayName: 'Ada Owner',
					capabilities: ['sandbox.access.use'],
					note: null,
					grantedBy: OPERATOR,
					grantedAt: 1_000,
					expiresAt: null,
					revokedAt: null,
					revokedBy: null,
				});
			}
		} finally {
			await dispose();
		}

		const revoke = await plan(
			'sandbox.access.revoke',
			'ada@example.test',
			target,
		);

		expect(revoke.data).toMatchObject({
			applied: false,
			tenant: { tenantId: target },
			grant: { id: `grant-${target}`, tenantId: target },
		});
	});
});
