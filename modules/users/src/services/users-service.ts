import type {
	AuthActor,
	AuthPrincipal,
	CreateTenantMemberInput,
	TenantMember,
	TenantRole,
} from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';

export interface CreateUserInput {
	readonly email: string;
	readonly password: string;
	readonly displayName: string;
	readonly role: string;
}

export interface UserDirectory {
	readonly users: readonly TenantMember[];
	readonly roles: readonly Pick<
		TenantRole,
		'id' | 'key' | 'name' | 'builtin'
	>[];
	readonly grantableScopes: readonly string[];
	/** Who is asking; the screen uses it to keep self-edits off limits. */
	readonly actor: { readonly accountId: string; readonly role: string };
	/** Shared auth.core setting, read through the declared dependency. */
	readonly passwordMinLength: number;
}

function actor(principal: AuthPrincipal): AuthActor {
	return {
		accountId: principal.accountId,
		tenantId: principal.tenantId,
		email: principal.email,
		role: principal.role,
		scopes: principal.scopes,
	};
}

/* Every write goes through the auth administration port with the acting
   principal, so the owner cap, the last-owner rule, and the audit trail are
   enforced in one place. */
export class UsersService {
	readonly #auth: AuthRuntime;

	constructor(auth: AuthRuntime) {
		this.#auth = auth;
	}

	async list(principal: AuthPrincipal): Promise<UserDirectory> {
		const service = await this.#auth.service();
		return {
			users: await service.listTenantMembers(principal.tenantId),
			roles: (await service.listRoles(principal.tenantId)).map(
				({ id, key, name, builtin }) => ({ id, key, name, builtin }),
			),
			grantableScopes: await service.listGrantableScopes(principal.tenantId),
			actor: { accountId: principal.accountId, role: principal.role },
			passwordMinLength: this.#auth.settings.passwordMinLength,
		};
	}

	async create(
		principal: AuthPrincipal,
		input: CreateUserInput,
	): Promise<TenantMember> {
		const record: CreateTenantMemberInput = {
			...input,
			tenantId: principal.tenantId,
		};
		return (await this.#auth.service()).createTenantMember(
			record,
			actor(principal),
		);
	}

	async rename(
		principal: AuthPrincipal,
		accountId: string,
		displayName: string,
	): Promise<TenantMember> {
		return (await this.#auth.service()).updateMemberDisplayName(
			actor(principal),
			accountId,
			displayName,
		);
	}

	async assignRole(
		principal: AuthPrincipal,
		accountId: string,
		roleKey: string,
	): Promise<TenantMember> {
		return (await this.#auth.service()).assignMemberRole(
			actor(principal),
			accountId,
			roleKey,
		);
	}

	async setStatus(
		principal: AuthPrincipal,
		accountId: string,
		status: 'active' | 'disabled',
	): Promise<TenantMember> {
		return (await this.#auth.service()).setMemberStatus(
			actor(principal),
			accountId,
			status,
		);
	}

	async remove(principal: AuthPrincipal, accountId: string): Promise<void> {
		await (
			await this.#auth.service()
		).removeMember(actor(principal), accountId);
	}

	async resetPassword(
		principal: AuthPrincipal,
		accountId: string,
		temporaryPassword: string,
	): Promise<TenantMember> {
		return (await this.#auth.service()).resetMemberPassword(
			actor(principal),
			accountId,
			temporaryPassword,
		);
	}

	async setScopes(
		principal: AuthPrincipal,
		accountId: string,
		scopes: readonly string[],
	): Promise<TenantMember> {
		return (await this.#auth.service()).setMembershipScopes(
			actor(principal),
			accountId,
			scopes,
		);
	}
}
