import type {
	AuthActor,
	AuthPrincipal,
	CreateTenantMemberInput,
	TenantMember,
	TenantRole,
} from '@coreloom/module-auth';
import type { AuthRuntime } from '@coreloom/module-auth/server';

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

	list(principal: AuthPrincipal): UserDirectory {
		const service = this.#auth.service();
		return {
			users: service.listTenantMembers(principal.tenantId),
			roles: service
				.listRoles(principal.tenantId)
				.map(({ id, key, name, builtin }) => ({ id, key, name, builtin })),
			grantableScopes: service.listGrantableScopes(principal.tenantId),
			actor: { accountId: principal.accountId, role: principal.role },
			passwordMinLength: this.#auth.settings.passwordMinLength,
		};
	}

	create(
		principal: AuthPrincipal,
		input: CreateUserInput,
	): Promise<TenantMember> {
		const record: CreateTenantMemberInput = {
			...input,
			tenantId: principal.tenantId,
		};
		return this.#auth.service().createTenantMember(record, actor(principal));
	}

	rename(
		principal: AuthPrincipal,
		accountId: string,
		displayName: string,
	): TenantMember {
		return this.#auth
			.service()
			.updateMemberDisplayName(actor(principal), accountId, displayName);
	}

	assignRole(
		principal: AuthPrincipal,
		accountId: string,
		roleKey: string,
	): TenantMember {
		return this.#auth
			.service()
			.assignMemberRole(actor(principal), accountId, roleKey);
	}

	setStatus(
		principal: AuthPrincipal,
		accountId: string,
		status: 'active' | 'disabled',
	): TenantMember {
		return this.#auth
			.service()
			.setMemberStatus(actor(principal), accountId, status);
	}

	remove(principal: AuthPrincipal, accountId: string): void {
		this.#auth.service().removeMember(actor(principal), accountId);
	}

	resetPassword(
		principal: AuthPrincipal,
		accountId: string,
		temporaryPassword: string,
	): Promise<TenantMember> {
		return this.#auth
			.service()
			.resetMemberPassword(actor(principal), accountId, temporaryPassword);
	}

	setScopes(
		principal: AuthPrincipal,
		accountId: string,
		scopes: readonly string[],
	): TenantMember {
		return this.#auth
			.service()
			.setMembershipScopes(actor(principal), accountId, scopes);
	}
}
