import type {
	AuthActor,
	AuthPrincipal,
	CreateTenantMemberInput,
	CreateTenantMemberWithoutPasswordInput,
	TenantMember,
	TenantMemberKeyset,
	TenantMemberSort,
	TenantMemberSortedPage,
	TenantRole,
} from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import { AuthServiceError } from '@flowdular/module-auth/server';

export interface CreateUserInput {
	readonly email: string;
	readonly password: string;
	readonly displayName: string;
	readonly role: string;
}

export type MemberStatusFilter = 'active' | 'disabled' | null;

export interface MemberListInput {
	readonly sort: TenantMemberSort;
	readonly direction: 'asc' | 'desc';
	readonly limit: number;
	/** A prefix of the display name or the address; empty narrows nothing. */
	readonly query: string;
	readonly status: MemberStatusFilter;
	readonly after: TenantMemberKeyset | null;
}

/** Ids one bulk member action may name. */
export const MEMBER_BULK_LIMIT = 100;

export interface MemberBulkOutcome {
	readonly accountId: string;
	readonly outcome: 'updated' | 'not-found' | 'refused';
	/** The stable auth.core code behind a refusal. */
	readonly reason?: string;
}

/** What the Members screen needs beside the page it shows. */
export interface UsersContext {
	readonly roles: readonly Pick<
		TenantRole,
		'id' | 'key' | 'name' | 'builtin'
	>[];
	readonly grantableScopes: readonly string[];
	/** Who is asking; the screen uses it to keep self-edits off limits. */
	readonly actor: { readonly accountId: string; readonly role: string };
	/** Shared auth.core setting, read through the declared dependency. */
	readonly passwordMinLength: number;
	/** Every membership of the workspace, counted in the database. */
	readonly memberCount: number;
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

	/* One page, sorted, narrowed and cut by auth.core; the screen shows it as
	   it arrives. */
	async list(
		principal: AuthPrincipal,
		input: MemberListInput,
	): Promise<TenantMemberSortedPage> {
		return (await this.#auth.service()).listTenantMembersSorted(
			principal.tenantId,
			{
				sort: input.sort,
				direction: input.direction,
				limit: input.limit,
				query: input.query,
				membershipStatus: input.status,
				after: input.after,
			},
		);
	}

	async context(principal: AuthPrincipal): Promise<UsersContext> {
		const service = await this.#auth.service();
		return {
			roles: (await service.listRoles(principal.tenantId)).map(
				({ id, key, name, builtin }) => ({ id, key, name, builtin }),
			),
			grantableScopes: await service.listGrantableScopes(principal.tenantId),
			actor: { accountId: principal.accountId, role: principal.role },
			passwordMinLength: this.#auth.settings.passwordMinLength,
			memberCount: await service.countTenantMembers(principal.tenantId),
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

	/* A member who holds no password: auth.core stores its unusable credential
	   marker, so no secret is drawn here and none has to be delivered. */
	async createWithoutPassword(
		principal: AuthPrincipal,
		input: Omit<CreateUserInput, 'password'>,
	): Promise<TenantMember> {
		const record: CreateTenantMemberWithoutPasswordInput = {
			...input,
			tenantId: principal.tenantId,
		};
		return (await this.#auth.service()).createTenantMemberWithoutPassword(
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

	/* Workspace access for several members at once: the membership path the
	   drawer's switch uses, once per id, so every row keeps its own audit event
	   and its own refusal (the acting principal, the last owner, an owner
	   touched by a non-owner) and a missing or foreign id costs nobody else. */
	setMembershipStatusMany(
		principal: AuthPrincipal,
		accountIds: readonly string[],
		status: 'active' | 'disabled',
	): Promise<readonly MemberBulkOutcome[]> {
		return this.#each(accountIds, async (accountId) => {
			await (
				await this.#auth.service()
			).setMembershipStatus(actor(principal), accountId, status);
		});
	}

	assignRoleMany(
		principal: AuthPrincipal,
		accountIds: readonly string[],
		roleKey: string,
	): Promise<readonly MemberBulkOutcome[]> {
		return this.#each(accountIds, async (accountId) => {
			await (
				await this.#auth.service()
			).assignMemberRole(actor(principal), accountId, roleKey);
		});
	}

	async #each(
		accountIds: readonly string[],
		write: (accountId: string) => Promise<void>,
	): Promise<readonly MemberBulkOutcome[]> {
		const outcomes: MemberBulkOutcome[] = [];
		for (const accountId of accountIds) {
			try {
				await write(accountId);
				outcomes.push({ accountId, outcome: 'updated' });
			} catch (error) {
				if (!(error instanceof AuthServiceError)) throw error;
				outcomes.push(
					error.code === 'ACCOUNT_NOT_FOUND'
						? { accountId, outcome: 'not-found' }
						: { accountId, outcome: 'refused', reason: error.code },
				);
			}
		}
		return outcomes;
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
