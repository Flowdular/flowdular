import { randomUUID } from 'node:crypto';
import type { TenantMember } from '@flowdular/module-auth';
import { AuthServiceError } from '@flowdular/module-auth/server';
import { serverLogger } from '@flowdular/server';
import {
	listResponse,
	parseFilter,
	parsePage,
	parsePatch,
	ScimError,
	scimMeta,
	SCIM_SCHEMAS,
	type ScimPatchOperation,
} from '../domain/scim.ts';
import {
	DIRECTORY_REASONS,
	type ProvisioningOperation,
	type ProvisioningOutcome,
	type ScimGroupMapping,
	type ScimToken,
	type ScimUserMapping,
} from '../domain/types.ts';
import { scimActor, type DirectoryAuthPort } from './auth-port.ts';
import { DirectoryUniqueViolation } from './database-repository.ts';
import type {
	DirectoryRepository,
	GroupMemberRow,
	GroupMemberStep,
} from './repository.ts';

const USER_FILTER_ATTRIBUTES = ['userName', 'externalId', 'id'] as const;
const GROUP_FILTER_ATTRIBUTES = ['displayName', 'externalId', 'id'] as const;
const MAX_USER_NAME = 320;
const MAX_EXTERNAL_ID = 256;
const MAX_DISPLAY_NAME = 200;
/** Members one group write may carry; the SCIM body ceiling is derived from it. */
export const MAX_GROUP_MEMBERS = 1_000;
/** New groups start unmapped and in the middle of the range an owner can use. */
const DEFAULT_GROUP_PRECEDENCE = 100;
/**
 * How many members one group carries in a response. A group is unbounded in
 * storage, so without this a single listing could load a whole workspace's
 * membership into one body. A larger group is truncated by userName; the
 * complete list belongs to a paged member query this version does not offer.
 */
const MAX_EMBEDDED_MEMBERS = 1_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Everything one authenticated SCIM request acts within. */
export interface ScimRequestContext {
	readonly tenantId: string;
	readonly token: ScimToken;
	/** Absolute base of this workspace's SCIM surface, for `meta.location`. */
	readonly baseUrl: string;
	readonly pageSizeMax: number;
	readonly defaultRole: string;
}

function invalid(reason: string, detail: string): ScimError {
	return new ScimError(400, 'invalidValue', reason, detail);
}

function notFound(reason: string, detail: string): ScimError {
	return new ScimError(404, null, reason, detail);
}

/**
 * auth.core refusals carry the decision this module has to report; mapping them
 * here keeps one translation instead of one per call site.
 */
function fromAuthError(error: unknown): ScimError | null {
	if (!(error instanceof AuthServiceError)) return null;
	switch (error.code) {
		case 'LAST_OWNER':
			return new ScimError(
				400,
				'mutability',
				DIRECTORY_REASONS.lastOwner,
				'A workspace must keep at least one active owner; change it in the administration screen.',
			);
		case 'ACCOUNT_EXISTS':
			return new ScimError(
				409,
				'uniqueness',
				DIRECTORY_REASONS.accountInUse,
				'The address already belongs to an account that holds another membership.',
			);
		case 'ROLE_NOT_FOUND':
			return invalid(
				DIRECTORY_REASONS.roleUnknown,
				'The mapped role does not exist in this workspace.',
			);
		case 'ACCOUNT_NOT_FOUND':
			return notFound(
				DIRECTORY_REASONS.memberNotFound,
				'The mapped account is no longer a member of this workspace.',
			);
		default:
			/* Anything else auth.core refuses is still the caller's request, not a
			   fault: answering 500 would tell a provider to retry forever. A 5xx
			   from auth.core stays a fault and reaches the generic handler. */
			return error.status >= 400 && error.status < 500
				? invalid(DIRECTORY_REASONS.invalidValue, error.message)
				: null;
	}
}

function text(
	value: unknown,
	field: string,
	maximum: number,
	reason = DIRECTORY_REASONS.invalidValue,
): string {
	if (typeof value !== 'string') {
		throw invalid(reason, `${field} must be a string.`);
	}
	const normalized = value.trim();
	if (normalized.length === 0 || normalized.length > maximum) {
		throw invalid(reason, `${field} must contain 1 to ${maximum} characters.`);
	}
	return normalized;
}

function optionalText(
	value: unknown,
	field: string,
	maximum: number,
): string | null {
	if (value === undefined || value === null || value === '') return null;
	return text(value, field, maximum);
}

function booleanValue(value: unknown, field: string): boolean {
	if (typeof value === 'boolean') return value;
	/* Providers send active as the string "True" or "false" often enough that
	   refusing it would break provisioning for a spelling difference. */
	if (typeof value === 'string') {
		const folded = value.trim().toLowerCase();
		if (folded === 'true') return true;
		if (folded === 'false') return false;
	}
	throw invalid(DIRECTORY_REASONS.invalidValue, `${field} must be a boolean.`);
}

/** userName is the address auth.core keys the account on. */
function userName(value: unknown): string {
	const normalized = text(value, 'userName', MAX_USER_NAME).toLowerCase();
	if (!EMAIL_PATTERN.test(normalized)) {
		throw invalid(
			DIRECTORY_REASONS.invalidValue,
			'userName must be an e-mail address.',
		);
	}
	return normalized;
}

function displayNameFrom(
	body: Record<string, unknown>,
	fallback: string,
): string {
	const direct = optionalText(body.displayName, 'displayName', 80);
	if (direct) return direct;
	const name = (body.name ?? {}) as Record<string, unknown>;
	const formatted = optionalText(name.formatted, 'name.formatted', 80);
	if (formatted) return formatted;
	const given = optionalText(name.givenName, 'name.givenName', 40);
	const family = optionalText(name.familyName, 'name.familyName', 40);
	/* Two 40 character halves join past the 80 auth.core accepts. */
	const joined = [given, family].filter(Boolean).join(' ').slice(0, 80).trim();
	if (joined.length >= 2) return joined;
	/* auth.core requires two characters; the address is the only other name a
	   provider always sends. */
	const local = fallback.slice(0, fallback.indexOf('@'));
	return local.length >= 2 ? local : fallback;
}

function immutableEmail(): ScimError {
	return new ScimError(
		400,
		'mutability',
		DIRECTORY_REASONS.immutableEmail,
		'The primary e-mail address cannot be changed through SCIM.',
	);
}

/**
 * The primary e-mail is the userName; auth.core exposes no address change. A
 * provider may send the whole array or one scalar through a sub-attribute path
 * such as `emails[type eq "work"].value`, and neither may move the address.
 */
function assertEmailsMatch(value: unknown, expected: string): void {
	if (value === undefined || value === null) return;
	if (typeof value === 'string') {
		if (value.trim().toLowerCase() !== expected) throw immutableEmail();
		return;
	}
	if (!Array.isArray(value) || value.length > 16) {
		throw invalid(DIRECTORY_REASONS.invalidValue, 'emails must be an array.');
	}
	for (const entry of value) {
		const record = (entry ?? {}) as Record<string, unknown>;
		if (record.primary !== true) continue;
		const address = optionalText(record.value, 'emails.value', MAX_USER_NAME);
		if (address !== null && address.toLowerCase() !== expected) {
			throw immutableEmail();
		}
	}
}

const MEMBER_PATH_FILTER = /^members\[\s*value\s+eq\s+"([^"]{1,128})"\s*\]$/i;

/** `members[value eq "<id>"]`, the single-member form providers send. */
function memberPathFilter(path: string | null): string | null {
	if (path === null) return null;
	return MEMBER_PATH_FILTER.exec(path)?.[1] ?? null;
}

function memberIds(value: unknown): readonly string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > MAX_GROUP_MEMBERS) {
		throw invalid(
			DIRECTORY_REASONS.invalidValue,
			`members must be an array of at most ${MAX_GROUP_MEMBERS} entries.`,
		);
	}
	return value.map((entry) => {
		const record = (entry ?? {}) as Record<string, unknown>;
		return text(record.value ?? entry, 'members.value', 128);
	});
}

/**
 * The workspace as one request sees it. Members and roles are read once and
 * the overlay carries what this request itself changed, so a request that
 * touches many users still costs one membership read.
 */
class WorkspaceView {
	#members: Promise<Map<string, TenantMember>> | undefined;
	#roles: Promise<ReadonlySet<string>> | undefined;
	readonly #roleOverlay = new Map<string, string>();
	readonly #statusOverlay = new Map<string, 'active' | 'disabled'>();

	constructor(
		private readonly auth: DirectoryAuthPort,
		private readonly tenantId: string,
	) {}

	members(): Promise<Map<string, TenantMember>> {
		return (this.#members ??= this.auth
			.listMembers(this.tenantId)
			.then(
				(members) =>
					new Map(members.map((member) => [member.accountId, member])),
			));
	}

	roles(): Promise<ReadonlySet<string>> {
		return (this.#roles ??= this.auth
			.listRoleKeys(this.tenantId)
			.then((keys) => new Set(keys)));
	}

	async member(accountId: string): Promise<TenantMember | null> {
		return (await this.members()).get(accountId) ?? null;
	}

	async roleOf(accountId: string): Promise<string | null> {
		const overlaid = this.#roleOverlay.get(accountId);
		if (overlaid !== undefined) return overlaid;
		return (await this.member(accountId))?.role ?? null;
	}

	async statusOf(accountId: string): Promise<'active' | 'disabled' | null> {
		const overlaid = this.#statusOverlay.get(accountId);
		if (overlaid !== undefined) return overlaid;
		return (await this.member(accountId))?.membershipStatus ?? null;
	}

	recordRole(accountId: string, roleKey: string): void {
		this.#roleOverlay.set(accountId, roleKey);
	}

	recordStatus(accountId: string, status: 'active' | 'disabled'): void {
		this.#statusOverlay.set(accountId, status);
	}
}

interface UserPatch {
	readonly externalId?: string | null | undefined;
	readonly displayName?: string | undefined;
	readonly active?: boolean | undefined;
}

interface ScimWrite {
	readonly outcome: ProvisioningOutcome;
	readonly resource: Record<string, unknown>;
	/** Set when only the run can tell which operation actually happened. */
	readonly operation?: ProvisioningOperation;
	/** Set when the subject only exists once the run created it. */
	readonly subject?: string;
}

export class ScimProvisioningService {
	constructor(
		private readonly repository: DirectoryRepository,
		private readonly auth: DirectoryAuthPort,
		private readonly now: () => number = Date.now,
	) {}

	async listUsers(
		context: ScimRequestContext,
		url: URL,
	): Promise<Record<string, unknown>> {
		const filter = parseFilter(
			url.searchParams.get('filter'),
			USER_FILTER_ATTRIBUTES,
		);
		const page = parsePage(url, context.pageSizeMax);
		const slice = await this.repository.listUsers(
			context.tenantId,
			{
				...(filter?.attribute === 'userName'
					? { userName: filter.value.toLowerCase() }
					: {}),
				...(filter?.attribute === 'externalId'
					? { externalId: filter.value }
					: {}),
				...(filter?.attribute === 'id' ? { id: filter.value } : {}),
			},
			page,
		);
		const view = new WorkspaceView(this.auth, context.tenantId);
		const resources: Record<string, unknown>[] = [];
		for (const mapping of slice.records) {
			resources.push(
				this.#userResource(
					context,
					mapping,
					await view.member(mapping.accountId),
				),
			);
		}
		return listResponse({
			totalResults: slice.totalResults,
			startIndex: page.startIndex,
			resources,
		});
	}

	async getUser(
		context: ScimRequestContext,
		id: string,
	): Promise<Record<string, unknown>> {
		const mapping = await this.#requireUser(context, id);
		const view = new WorkspaceView(this.auth, context.tenantId);
		return this.#userResource(
			context,
			mapping,
			await view.member(mapping.accountId),
		);
	}

	async createUser(
		context: ScimRequestContext,
		body: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const address = userName(body.userName);
		return this.#recorded(context, 'user-create', address, async () => {
			if (await this.repository.findUserByUserName(context.tenantId, address)) {
				throw new ScimError(
					409,
					'uniqueness',
					DIRECTORY_REASONS.userExists,
					'A SCIM user with this userName already exists in the workspace.',
				);
			}
			/* Refused before the first write: a workspace nobody can sign in to
			   must not end up holding provisioned members. */
			if (!(await this.auth.hasEnabledIdentityProvider(context.tenantId))) {
				throw invalid(
					DIRECTORY_REASONS.noEnabledProvider,
					'The workspace has no enabled identity provider, so a provisioned user could never sign in.',
				);
			}
			const memberships = await this.auth.countAccountMemberships(address);
			if (memberships !== null && memberships > 0) {
				throw new ScimError(
					409,
					'uniqueness',
					DIRECTORY_REASONS.accountInUse,
					'The address already belongs to an account that holds another membership.',
				);
			}
			assertEmailsMatch(body.emails, address);
			const view = new WorkspaceView(this.auth, context.tenantId);
			const role = await this.#requireRole(view, context.defaultRole, true);
			const member = await this.#throughAuth(() =>
				this.auth.createMember(scimActor(context.tenantId, context.token.id), {
					email: address,
					displayName: displayNameFrom(body, address),
					role,
				}),
			);
			const createdAt = this.now();
			const mapping: ScimUserMapping = {
				id: randomUUID(),
				tenantId: context.tenantId,
				externalId: optionalText(
					body.externalId,
					'externalId',
					MAX_EXTERNAL_ID,
				),
				userName: address,
				accountId: member.accountId,
				active: true,
				createdAt,
				lastSyncedAt: createdAt,
			};
			await this.#insertMapping(mapping);
			return {
				outcome: 'applied' as const,
				resource: this.#userResource(context, mapping, member),
			};
		});
	}

	async replaceUser(
		context: ScimRequestContext,
		id: string,
		body: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const mapping = await this.#requireUser(context, id);
		return this.#writeUser(context, mapping, () => {
			if (
				body.userName !== undefined &&
				userName(body.userName) !== mapping.userName
			) {
				throw new ScimError(
					400,
					'mutability',
					DIRECTORY_REASONS.immutableUserName,
					'userName cannot be changed through SCIM.',
				);
			}
			assertEmailsMatch(body.emails, mapping.userName);
			return {
				externalId:
					body.externalId === undefined
						? undefined
						: optionalText(body.externalId, 'externalId', MAX_EXTERNAL_ID),
				displayName:
					body.displayName === undefined && body.name === undefined
						? undefined
						: displayNameFrom(body, mapping.userName),
				/* A replace without `active` keeps the current membership state: a
				   missing attribute must never silently reactivate a deprovisioned
				   member, which strict replace semantics would do. */
				active:
					body.active === undefined
						? undefined
						: booleanValue(body.active, 'active'),
			};
		});
	}

	async patchUser(
		context: ScimRequestContext,
		id: string,
		body: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const mapping = await this.#requireUser(context, id);
		return this.#writeUser(context, mapping, () => {
			const patch = parsePatch(body);
			let externalId: string | null | undefined;
			let displayName: string | undefined;
			let active: boolean | undefined;
			for (const operation of patch) {
				for (const [attribute, value] of this.#userPatchTargets(operation)) {
					if (attribute === 'active') {
						active =
							operation.op === 'remove' ? false : booleanValue(value, 'active');
					} else if (attribute === 'displayName') {
						displayName =
							operation.op === 'remove'
								? mapping.userName
								: displayNameFrom({ displayName: value }, mapping.userName);
					} else if (attribute === 'name') {
						displayName =
							operation.op === 'remove'
								? mapping.userName
								: displayNameFrom({ name: value }, mapping.userName);
					} else if (attribute === 'externalId') {
						externalId =
							operation.op === 'remove'
								? null
								: optionalText(value, 'externalId', MAX_EXTERNAL_ID);
					} else if (attribute === 'emails') {
						assertEmailsMatch(value, mapping.userName);
					} else if (attribute === 'userName') {
						/* A provider that echoes the current userName has changed
						   nothing, and a repeat of the current state must succeed. */
						if (
							operation.op === 'remove' ||
							userName(value) !== mapping.userName
						) {
							throw new ScimError(
								400,
								'mutability',
								DIRECTORY_REASONS.immutableUserName,
								'userName cannot be changed through SCIM.',
							);
						}
					}
				}
			}
			return { externalId, displayName, active };
		});
	}

	async deleteUser(context: ScimRequestContext, id: string): Promise<void> {
		const mapping = await this.#requireUser(context, id);
		/* DELETE deprovisions: the membership is disabled, the account and every
		   other workspace it belongs to stay untouched. */
		await this.#writeUser(context, mapping, () => ({ active: false }));
	}

	/**
	 * Every attribute a PATCH operation targets, from either the path or the
	 * value object of a pathless operation.
	 */
	#userPatchTargets(
		operation: ScimPatchOperation,
	): readonly (readonly [string, unknown])[] {
		if (operation.path === null) {
			const value = (operation.value ?? {}) as Record<string, unknown>;
			if (typeof operation.value !== 'object' || operation.value === null) {
				throw invalid(
					DIRECTORY_REASONS.invalidValue,
					'A patch without a path must carry an object value.',
				);
			}
			return Object.entries(value).map(
				([key, entry]) => [this.#userAttribute(key), entry] as const,
			);
		}
		return [[this.#userAttribute(operation.path), operation.value] as const];
	}

	#userAttribute(path: string): string {
		const attribute = path.split('.')[0]!.split('[')[0]!.trim();
		const known = [
			'active',
			'displayName',
			'name',
			'emails',
			'externalId',
			'userName',
		];
		const matched = known.find(
			(candidate) => candidate.toLowerCase() === attribute.toLowerCase(),
		);
		if (!matched) {
			throw new ScimError(
				400,
				'noTarget',
				DIRECTORY_REASONS.unsupportedPath,
				`${attribute} is not an attribute this service provider maintains.`,
			);
		}
		return matched;
	}

	async #writeUser(
		context: ScimRequestContext,
		mapping: ScimUserMapping,
		resolve: () => UserPatch,
	): Promise<Record<string, unknown>> {
		/* The patch is resolved inside the run so a refusal while reading the
		   body is logged with everything else this operation did. */
		return this.#recorded(context, 'user-update', mapping.id, async () => {
			const patch = resolve();
			const view = new WorkspaceView(this.auth, context.tenantId);
			const actor = scimActor(context.tenantId, context.token.id);
			const member = await view.member(mapping.accountId);
			if (!member) {
				throw notFound(
					DIRECTORY_REASONS.memberNotFound,
					'The mapped account is no longer a member of this workspace.',
				);
			}
			let changed = false;
			let statusMoved = false;
			let displayName = member.displayName;
			if (
				patch.displayName !== undefined &&
				patch.displayName !== member.displayName
			) {
				await this.#throughAuth(() =>
					this.auth.setDisplayName(actor, member.accountId, patch.displayName!),
				);
				displayName = patch.displayName;
				changed = true;
			}
			if (patch.active !== undefined) {
				const target = patch.active ? 'active' : 'disabled';
				if ((await view.statusOf(member.accountId)) !== target) {
					await this.#throughAuth(() =>
						this.auth.setMembershipStatus(actor, member.accountId, target),
					);
					view.recordStatus(member.accountId, target);
					statusMoved = true;
					changed = true;
				}
			}
			const active =
				patch.active ?? (await view.statusOf(member.accountId)) === 'active';
			if (
				(patch.externalId !== undefined &&
					patch.externalId !== mapping.externalId) ||
				active !== mapping.active
			) {
				await this.repository.updateUser({
					tenantId: context.tenantId,
					id: mapping.id,
					externalId:
						patch.externalId === undefined
							? mapping.externalId
							: patch.externalId,
					active,
					lastSyncedAt: this.now(),
				});
				changed = true;
			}
			const stored =
				(await this.repository.findUserById(context.tenantId, mapping.id)) ??
				mapping;
			return {
				outcome: changed ? ('applied' as const) : ('unchanged' as const),
				/* A status that did not move, next to a change that did, is an
				   update; a request that changed nothing keeps the name of what the
				   provider asked for. */
				operation:
					patch.active === undefined
						? 'user-update'
						: statusMoved || !changed
							? patch.active
								? 'user-reactivate'
								: 'user-deactivate'
							: 'user-update',
				/* The member is rendered from what this run just applied rather
				   than from a second full listing of the workspace. */
				resource: this.#userResource(context, stored, {
					...member,
					displayName,
					membershipStatus: active ? 'active' : 'disabled',
				}),
			};
		});
	}

	async listGroups(
		context: ScimRequestContext,
		url: URL,
	): Promise<Record<string, unknown>> {
		const filter = parseFilter(
			url.searchParams.get('filter'),
			GROUP_FILTER_ATTRIBUTES,
		);
		const page = parsePage(url, context.pageSizeMax);
		const slice = await this.repository.listGroups(
			context.tenantId,
			{
				...(filter?.attribute === 'displayName'
					? { displayName: filter.value }
					: {}),
				...(filter?.attribute === 'externalId'
					? { externalId: filter.value }
					: {}),
				...(filter?.attribute === 'id' ? { id: filter.value } : {}),
			},
			page,
		);
		const members = await this.repository.listMembersOfGroups(
			context.tenantId,
			slice.records.map((group) => group.id),
			MAX_EMBEDDED_MEMBERS,
		);
		/* Grouped once rather than filtered per group: a page of 200 groups must
		   not cost 200 passes over every member row it read. */
		const byGroup = new Map<string, GroupMemberRow[]>();
		for (const member of members) {
			const held = byGroup.get(member.groupId);
			if (held) held.push(member);
			else byGroup.set(member.groupId, [member]);
		}
		return listResponse({
			totalResults: slice.totalResults,
			startIndex: page.startIndex,
			resources: slice.records.map((group) =>
				this.#groupResource(context, group, byGroup.get(group.id) ?? []),
			),
		});
	}

	async getGroup(
		context: ScimRequestContext,
		id: string,
	): Promise<Record<string, unknown>> {
		const group = await this.#requireGroup(context, id);
		return this.#groupResource(
			context,
			group,
			await this.repository.listMembersOfGroups(
				context.tenantId,
				[group.id],
				MAX_EMBEDDED_MEMBERS,
			),
		);
	}

	async createGroup(
		context: ScimRequestContext,
		body: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		/* Parsed here so a refused create still names what it tried to create;
		   the run replaces the subject with the group id once one exists. */
		const requestedName = optionalText(
			body.displayName,
			'displayName',
			MAX_DISPLAY_NAME,
		);
		return this.#recorded(
			context,
			'group-create',
			requestedName ?? '',
			async () => {
				const displayName = text(
					body.displayName,
					'displayName',
					MAX_DISPLAY_NAME,
				);
				const createdAt = this.now();
				const group = {
					id: randomUUID(),
					tenantId: context.tenantId,
					externalId: optionalText(
						body.externalId,
						'externalId',
						MAX_EXTERNAL_ID,
					),
					displayName,
					/* A new group grants nothing until an owner maps it to a role. */
					roleKey: null,
					precedence: DEFAULT_GROUP_PRECEDENCE,
					createdAt,
					updatedAt: createdAt,
				};
				const requested = await this.#resolveMembers(
					context,
					memberIds(body.members),
				);
				try {
					await this.repository.insertGroup(group);
				} catch (error) {
					throw this.#groupConflict(error);
				}
				const change = await this.repository.applyGroupMembers({
					tenantId: context.tenantId,
					groupId: group.id,
					steps: [{ kind: 'set', members: requested }],
					now: createdAt,
				});
				await this.#recalculate(context, [...change.added, ...change.removed]);
				return {
					outcome: 'applied' as const,
					subject: group.id,
					resource: await this.#groupWrite(context, group.id, true).then(
						(write) => write.resource,
					),
				};
			},
		);
	}

	async replaceGroup(
		context: ScimRequestContext,
		id: string,
		body: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const group = await this.#requireGroup(context, id);
		return this.#recorded(context, 'group-update', group.id, async () => {
			const displayName =
				body.displayName === undefined
					? group.displayName
					: text(body.displayName, 'displayName', MAX_DISPLAY_NAME);
			const members =
				body.members === undefined
					? null
					: await this.#resolveMembers(context, memberIds(body.members));
			const changed = await this.#applyGroupChange(context, group, {
				displayName,
				externalId:
					body.externalId === undefined
						? group.externalId
						: optionalText(body.externalId, 'externalId', MAX_EXTERNAL_ID),
				steps: members === null ? [] : [{ kind: 'set', members }],
			});
			return this.#groupWrite(context, group.id, changed);
		});
	}

	async patchGroup(
		context: ScimRequestContext,
		id: string,
		body: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const group = await this.#requireGroup(context, id);
		/* The operation is decided before the body is walked, because the walk
		   is what can refuse, and the refusal belongs in the log under the
		   operation the provider attempted. */
		const patch = parsePatch(body);
		const touchesMembers = patch.some((operation) =>
			this.#groupPatchTargets(operation).some(
				([attribute]) => attribute === 'members',
			),
		);
		return this.#recorded(
			context,
			touchesMembers ? 'membership-change' : 'group-update',
			group.id,
			async () => {
				let displayName = group.displayName;
				let externalId = group.externalId;
				const steps: GroupMemberStep[] = [];
				for (const operation of patch) {
					for (const [attribute, value] of this.#groupPatchTargets(operation)) {
						if (attribute === 'members') {
							/* Okta and Entra address a single member through the path
							   filter rather than the value, so both spellings resolve. */
							const targeted = memberPathFilter(operation.path);
							const ids =
								targeted === null
									? memberIds(value)
									: [targeted, ...memberIds(value)];
							const resolved = await this.#resolveMembers(context, ids);
							if (operation.op === 'replace') {
								steps.push({ kind: 'set', members: resolved });
							} else if (operation.op === 'add') {
								steps.push({ kind: 'add', members: resolved });
							} else if (resolved.length === 0) {
								/* `remove` with no value and no filter clears the
								   membership, which is how a provider empties a group. */
								steps.push({ kind: 'set', members: [] });
							} else {
								steps.push({ kind: 'remove', members: resolved });
							}
						} else if (attribute === 'displayName') {
							displayName =
								operation.op === 'remove'
									? group.displayName
									: text(value, 'displayName', MAX_DISPLAY_NAME);
						} else if (attribute === 'externalId') {
							externalId =
								operation.op === 'remove'
									? null
									: optionalText(value, 'externalId', MAX_EXTERNAL_ID);
						}
					}
				}
				const changed = await this.#applyGroupChange(context, group, {
					displayName,
					externalId,
					steps,
				});
				return this.#groupWrite(context, group.id, changed);
			},
		);
	}

	async deleteGroup(context: ScimRequestContext, id: string): Promise<void> {
		const group = await this.#requireGroup(context, id);
		await this.#recorded(context, 'group-delete', group.id, async () => {
			const members = await this.repository.listGroupMemberIds(
				context.tenantId,
				group.id,
			);
			const removed = await this.repository.deleteGroup(
				context.tenantId,
				group.id,
			);
			try {
				await this.#recalculate(context, members);
			} catch (error) {
				/* Same all-or-nothing rule as a membership change: a refused role
				   change puts the group and its members back, and a restore that
				   fails is reported instead of leaving the group gone in silence. */
				if (removed) {
					await this.#unwind(
						context,
						[
							async () => {
								await this.repository.insertGroup(group);
								await this.repository.applyGroupMembers({
									tenantId: context.tenantId,
									groupId: group.id,
									steps: [{ kind: 'set', members }],
									now: this.now(),
								});
							},
						],
						group.id,
						'group-delete',
					);
				}
				throw error;
			}
			return {
				outcome: removed ? ('applied' as const) : ('unchanged' as const),
				resource: {},
			};
		});
	}

	#groupPatchTargets(
		operation: ScimPatchOperation,
	): readonly (readonly [string, unknown])[] {
		if (operation.path === null) {
			if (
				typeof operation.value !== 'object' ||
				operation.value === null ||
				Array.isArray(operation.value)
			) {
				throw new ScimError(
					400,
					'noTarget',
					DIRECTORY_REASONS.unsupportedPath,
					'A group patch without a path must carry an object value.',
				);
			}
			return Object.entries(operation.value as Record<string, unknown>).map(
				([key, entry]) => [this.#knownGroupAttribute(key), entry] as const,
			);
		}
		return [
			[this.#knownGroupAttribute(operation.path), operation.value] as const,
		];
	}

	#knownGroupAttribute(path: string): string {
		const attribute = path.split('[')[0]!.split('.')[0]!.trim();
		const matched = ['members', 'displayName', 'externalId'].find(
			(candidate) => candidate.toLowerCase() === attribute.toLowerCase(),
		);
		if (!matched) {
			throw new ScimError(
				400,
				'noTarget',
				DIRECTORY_REASONS.unsupportedPath,
				`${attribute} is not an attribute this service provider maintains.`,
			);
		}
		return matched;
	}

	async #applyGroupChange(
		context: ScimRequestContext,
		group: ScimGroupMapping,
		change: {
			readonly displayName: string;
			readonly externalId: string | null;
			readonly steps: readonly GroupMemberStep[];
		},
	): Promise<boolean> {
		/* Role assignment is a second system, so it cannot join this module's
		   transaction. Each applied step records how to undo itself, and a
		   refusal from auth.core unwinds them: the provider sees the group and
		   the roles exactly as they were. */
		const undo: (() => Promise<unknown>)[] = [];
		let changed = false;
		try {
			if (
				change.displayName !== group.displayName ||
				change.externalId !== group.externalId
			) {
				await this.#renameGroup(context, group, {
					displayName: change.displayName,
					externalId: change.externalId,
				});
				undo.push(() =>
					this.#renameGroup(context, group, {
						displayName: group.displayName,
						externalId: group.externalId,
					}),
				);
				changed = true;
			}
			const applied =
				change.steps.length === 0
					? { added: [], removed: [] }
					: await this.repository.applyGroupMembers({
							tenantId: context.tenantId,
							groupId: group.id,
							steps: change.steps,
							now: this.now(),
						});
			const touched = [...applied.added, ...applied.removed];
			if (touched.length > 0) {
				undo.push(() =>
					this.repository.applyGroupMembers({
						tenantId: context.tenantId,
						groupId: group.id,
						steps: [
							{ kind: 'remove', members: applied.added },
							{ kind: 'add', members: applied.removed },
						],
						now: this.now(),
					}),
				);
				changed = true;
			}
			await this.#recalculate(context, touched);
			return changed;
		} catch (error) {
			await this.#unwind(context, undo, group.id, 'group-update');
			throw error;
		}
	}

	/**
	 * Runs the undo steps of a refused change. A step that fails leaves the
	 * workspace between two states, which nobody would otherwise see: it is
	 * reported as a fault rather than answered as a clean refusal.
	 */
	async #unwind(
		context: ScimRequestContext,
		undo: readonly (() => Promise<unknown>)[],
		subject: string,
		operation: ProvisioningOperation,
	): Promise<void> {
		for (const step of [...undo].reverse()) {
			try {
				await step();
			} catch (error) {
				serverLogger().error('directory rollback failed', {
					module: 'directory.core',
					err: { name: error instanceof Error ? error.name : 'non-error' },
					fields: { subject, tenantId: context.tenantId },
				});
				/* The provisioning log is the operator's own surface, so the
				   inconsistency is recorded there as well as in the server log. */
				await this.#append(
					context,
					operation,
					subject,
					'refused',
					DIRECTORY_REASONS.rollbackFailed,
				).catch(() => undefined);
				throw new ScimError(
					500,
					null,
					DIRECTORY_REASONS.rollbackFailed,
					'The change was refused and could not be undone; the workspace needs an operator.',
				);
			}
		}
	}

	async #renameGroup(
		context: ScimRequestContext,
		group: ScimGroupMapping,
		to: { readonly displayName: string; readonly externalId: string | null },
	): Promise<void> {
		try {
			await this.repository.updateGroup({
				tenantId: context.tenantId,
				id: group.id,
				externalId: to.externalId,
				displayName: to.displayName,
				roleKey: group.roleKey,
				precedence: group.precedence,
				updatedAt: this.now(),
			});
		} catch (error) {
			throw this.#groupConflict(error);
		}
	}

	async #groupWrite(
		context: ScimRequestContext,
		id: string,
		changed: boolean,
	): Promise<ScimWrite> {
		const stored = await this.repository.findGroupById(context.tenantId, id);
		if (!stored) {
			throw notFound(
				DIRECTORY_REASONS.groupNotFound,
				'The group no longer exists in this workspace.',
			);
		}
		return {
			outcome: changed ? 'applied' : 'unchanged',
			resource: this.#groupResource(
				context,
				stored,
				await this.repository.listMembersOfGroups(
					context.tenantId,
					[id],
					MAX_EMBEDDED_MEMBERS,
				),
			),
		};
	}

	#groupConflict(error: unknown): unknown {
		if (error instanceof DirectoryUniqueViolation) {
			return new ScimError(
				409,
				'uniqueness',
				DIRECTORY_REASONS.groupExists,
				'A group with this displayName already exists in the workspace.',
			);
		}
		return error;
	}

	/** One query for the whole member list, refusing the first id that is unknown. */
	async #resolveMembers(
		context: ScimRequestContext,
		ids: readonly string[],
	): Promise<readonly string[]> {
		const unique = [...new Set(ids)];
		if (unique.length === 0) return [];
		const known = new Set(
			(await this.repository.findUsersByIds(context.tenantId, unique)).map(
				(mapping) => mapping.id,
			),
		);
		for (const id of unique) {
			if (!known.has(id)) {
				throw invalid(
					DIRECTORY_REASONS.userNotFound,
					'A member value names a SCIM user that does not exist in this workspace.',
				);
			}
		}
		return unique;
	}

	/**
	 * Re-derives the role of every user whose group membership moved. Precedence
	 * comes from the one repository query the administration screen uses, so the
	 * two paths can never disagree on which mapped group wins. A user whose
	 * resolved role already matches is left alone, so a repeat of the same
	 * membership state writes nothing. A refusal partway through undoes the role
	 * changes this pass already made, and the log is written only once the pass
	 * has succeeded, so it never records a change that was rolled back.
	 */
	async #recalculate(
		context: ScimRequestContext,
		userIds: readonly string[],
	): Promise<void> {
		if (userIds.length === 0) return;
		const view = new WorkspaceView(this.auth, context.tenantId);
		const actor = scimActor(context.tenantId, context.token.id);
		const applied: { accountId: string; previous: string }[] = [];
		const events: { subject: string; outcome: ProvisioningOutcome }[] = [];
		const resolved = await this.repository.resolvedRolesForUsers(
			context.tenantId,
			userIds,
		);
		try {
			for (const member of resolved) {
				const status = await view.statusOf(member.accountId);
				if (status === null) {
					/* The mapping outlived the membership. Visible in the log rather
					   than failing every other member of the same request. */
					events.push({ subject: member.userId, outcome: 'refused' });
					continue;
				}
				/* A disabled membership holds no role anyone can act on, and
				   auth.core counts it out of the owner tally, so recomputing it
				   would refuse a change the workspace can make. */
				if (status !== 'active') continue;
				const current = await view.roleOf(member.accountId);
				if (current === null) continue;
				const target = await this.#requireRole(
					view,
					member.roleKey ?? context.defaultRole,
					member.roleKey === null,
				);
				if (current === target) continue;
				await this.#throughAuth(() =>
					this.auth.assignRole(actor, member.accountId, target),
				);
				applied.push({ accountId: member.accountId, previous: current });
				view.recordRole(member.accountId, target);
				events.push({ subject: member.userId, outcome: 'applied' });
			}
		} catch (error) {
			for (const change of applied.reverse()) {
				/* Restoring a role the workspace already held cannot be refused; a
				   failure here is reported by the original error, not replaced. */
				await this.auth
					.assignRole(actor, change.accountId, change.previous)
					.catch(() => undefined);
			}
			throw error;
		}
		await this.#appendAll(
			context,
			events.map((event) => ({
				operation: 'membership-change' as const,
				subject: event.subject,
				outcome: event.outcome,
				reason:
					event.outcome === 'refused' ? DIRECTORY_REASONS.memberNotFound : null,
			})),
		);
	}

	async #requireRole(
		view: WorkspaceView,
		roleKey: string,
		isDefault: boolean,
	): Promise<string> {
		if ((await view.roles()).has(roleKey)) return roleKey;
		throw invalid(
			isDefault
				? DIRECTORY_REASONS.defaultRoleUnknown
				: DIRECTORY_REASONS.roleUnknown,
			`The role "${roleKey}" does not exist in this workspace.`,
		);
	}

	async #insertMapping(mapping: ScimUserMapping): Promise<void> {
		try {
			await this.repository.insertUser(mapping);
		} catch (error) {
			if (error instanceof DirectoryUniqueViolation) {
				throw new ScimError(
					409,
					'uniqueness',
					DIRECTORY_REASONS.accountInUse,
					'The account is already mapped to a SCIM user in this workspace.',
				);
			}
			throw error;
		}
	}

	async #requireUser(
		context: ScimRequestContext,
		id: string,
	): Promise<ScimUserMapping> {
		const mapping =
			id.length <= 128
				? await this.repository.findUserById(context.tenantId, id)
				: null;
		if (!mapping) {
			throw notFound(
				DIRECTORY_REASONS.userNotFound,
				'The SCIM user does not exist in this workspace.',
			);
		}
		return mapping;
	}

	async #requireGroup(
		context: ScimRequestContext,
		id: string,
	): Promise<ScimGroupMapping> {
		const group =
			id.length <= 128
				? await this.repository.findGroupById(context.tenantId, id)
				: null;
		if (!group) {
			throw notFound(
				DIRECTORY_REASONS.groupNotFound,
				'The group does not exist in this workspace.',
			);
		}
		return group;
	}

	async #throughAuth<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			const translated = fromAuthError(error);
			if (translated) throw translated;
			throw error;
		}
	}

	/**
	 * Runs one SCIM operation and writes exactly one provisioning event for it,
	 * including the refusal. The event carries the token id and the stable
	 * reason, never the token value.
	 */
	async #recorded(
		context: ScimRequestContext,
		operation: ProvisioningOperation,
		subject: string,
		run: () => Promise<ScimWrite>,
	): Promise<Record<string, unknown>> {
		try {
			const result = await run();
			await this.#append(
				context,
				result.operation ?? operation,
				result.subject ?? subject,
				result.outcome,
				null,
			);
			return result.resource;
		} catch (error) {
			if (error instanceof ScimError) {
				await this.#append(
					context,
					operation,
					subject,
					'refused',
					error.reason,
				);
			}
			throw error;
		}
	}

	async #append(
		context: ScimRequestContext,
		operation: ProvisioningOperation,
		subject: string,
		outcome: ProvisioningOutcome,
		reason: string | null,
	): Promise<void> {
		await this.#appendAll(context, [{ operation, subject, outcome, reason }]);
	}

	/* One write for the whole pass: a membership change over a large group would
	   otherwise cost one transaction per member it recorded. */
	async #appendAll(
		context: ScimRequestContext,
		entries: readonly {
			readonly operation: ProvisioningOperation;
			readonly subject: string;
			readonly outcome: ProvisioningOutcome;
			readonly reason: string | null;
		}[],
	): Promise<void> {
		if (entries.length === 0) return;
		const occurredAt = this.now();
		await this.repository.appendEvents(
			entries.map((entry) => ({
				id: randomUUID(),
				tenantId: context.tenantId,
				tokenId: context.token.id,
				operation: entry.operation,
				subject: entry.subject.slice(0, 320),
				outcome: entry.outcome,
				reason: entry.reason,
				occurredAt,
			})),
		);
	}

	#userResource(
		context: ScimRequestContext,
		mapping: ScimUserMapping,
		member: TenantMember | null,
	): Record<string, unknown> {
		const displayName = member?.displayName ?? mapping.userName;
		return {
			schemas: [SCIM_SCHEMAS.user],
			id: mapping.id,
			...(mapping.externalId === null
				? {}
				: { externalId: mapping.externalId }),
			userName: mapping.userName,
			displayName,
			name: { formatted: displayName },
			emails: [{ value: mapping.userName, primary: true, type: 'work' }],
			/* The workspace's own membership status is the truth; the stored flag
			   is the mirror the screens and the log read. */
			active: member ? member.membershipStatus === 'active' : mapping.active,
			meta: scimMeta({
				resourceType: 'User',
				createdAt: mapping.createdAt,
				updatedAt: mapping.lastSyncedAt,
				baseUrl: context.baseUrl,
				id: mapping.id,
			}),
		};
	}

	#groupResource(
		context: ScimRequestContext,
		group: ScimGroupMapping,
		members: readonly { groupId: string; userId: string; userName: string }[],
	): Record<string, unknown> {
		return {
			schemas: [SCIM_SCHEMAS.group],
			id: group.id,
			...(group.externalId === null ? {} : { externalId: group.externalId }),
			displayName: group.displayName,
			members: members.map((member) => ({
				value: member.userId,
				display: member.userName,
				$ref: `${context.baseUrl}/Users/${member.userId}`,
			})),
			meta: scimMeta({
				resourceType: 'Group',
				createdAt: group.createdAt,
				updatedAt: group.updatedAt,
				baseUrl: context.baseUrl,
				id: group.id,
			}),
		};
	}
}
