import type {
	DataClassExportSink,
	DataClassExportSummary,
} from '@flowdular/kernel';
import type { AuthActor } from '@flowdular/module-auth';
import { AuthServiceError } from '@flowdular/module-auth/server';
import type {
	ProvisioningEvent,
	ProvisioningEventQuery,
	ScimGroupMapping,
} from '../domain/types.ts';
import type { DirectoryAuthPort } from './auth-port.ts';
import { DirectoryUniqueViolation } from './database-repository.ts';
import type { DirectoryRepository } from './repository.ts';
import { bounded, DirectoryServiceError } from './service-error.ts';

/** Hard ceiling of one provisioning log page, whatever a caller asks for. */
export const MAX_EVENT_PAGE = 200;

/** Rows one export query holds, so a long history costs bounded memory. */
export const EXPORT_PAGE = 500;

/** Rows one sweep call may remove, whatever limit the caller asks for. */
export const MAX_SWEEP_BATCH = 100_000;

export interface GroupMappingsView {
	readonly groups: readonly ScimGroupMapping[];
	/** The workspace roles a mapping may point at, for the screen's select. */
	readonly roles: readonly string[];
	readonly defaultRole: string;
}

export interface MapGroupInput {
	readonly id: string;
	/** Empty clears the mapping: the group is tracked but grants nothing. */
	readonly roleKey: string | null;
	readonly precedence: number;
}

/**
 * The administration side of directory.core: what an owner reads and changes in
 * the workspace screens. SCIM operations live in `ScimProvisioningService`.
 */
export class DirectoryAdministrationService {
	constructor(
		private readonly repository: DirectoryRepository,
		private readonly auth: DirectoryAuthPort,
		private readonly now: () => number = Date.now,
	) {}

	async listGroupMappings(
		tenantId: string,
		defaultRole: string,
	): Promise<GroupMappingsView> {
		const [groups, roles] = await Promise.all([
			this.repository.listGroups(
				tenantId,
				{},
				{ startIndex: 1, count: MAX_EVENT_PAGE },
			),
			this.auth.listRoleKeys(tenantId),
		]);
		return { groups: groups.records, roles, defaultRole };
	}

	/**
	 * Sets or clears the role of one group and re-derives the role of every
	 * member it affects. A refusal from auth.core, such as the last owner rule,
	 * puts the mapping and every role already changed back.
	 */
	async mapGroup(
		actor: AuthActor,
		input: MapGroupInput,
		defaultRole: string,
	): Promise<ScimGroupMapping> {
		const tenantId = actor.tenantId;
		const group = await this.repository.findGroupById(
			tenantId,
			bounded(input.id, 'id', 1, 128),
		);
		if (!group) {
			throw new DirectoryServiceError(
				'GROUP_NOT_FOUND',
				'The group does not exist in this workspace.',
				404,
			);
		}
		const roleKey =
			input.roleKey === null || input.roleKey.trim() === ''
				? null
				: bounded(input.roleKey, 'roleKey', 2, 64);
		const roles = new Set(await this.auth.listRoleKeys(tenantId));
		if (roleKey !== null && !roles.has(roleKey)) {
			throw new DirectoryServiceError(
				'ROLE_UNKNOWN',
				'The role does not exist in this workspace.',
			);
		}
		if (
			!Number.isSafeInteger(input.precedence) ||
			input.precedence < 0 ||
			input.precedence > 10_000
		) {
			throw new DirectoryServiceError(
				'INVALID_INPUT',
				'precedence must be an integer between 0 and 10000.',
			);
		}
		if (roleKey === group.roleKey && input.precedence === group.precedence) {
			return group;
		}
		await this.#write(tenantId, group, roleKey, input.precedence);
		try {
			await this.#recalculate(actor, group.id, roles, defaultRole);
		} catch (error) {
			await this.#write(tenantId, group, group.roleKey, group.precedence).catch(
				() => undefined,
			);
			throw error;
		}
		return (await this.repository.findGroupById(tenantId, group.id)) ?? group;
	}

	listEvents(
		tenantId: string,
		query: ProvisioningEventQuery,
	): Promise<readonly ProvisioningEvent[]> {
		return this.repository.listEvents(tenantId, {
			...query,
			limit: Math.min(Math.max(query.limit, 1), MAX_EVENT_PAGE),
		});
	}

	/**
	 * The retention sweep of `directory.core.provisioning-events`. Events that
	 * occurred strictly before the cutoff go, at most `limit` of them, so one
	 * pass is bounded however long the workspace has been provisioning.
	 */
	sweepEvents(
		tenantId: string,
		cutoff: Date,
		limit: number,
	): Promise<{ readonly removed: number }> {
		return this.repository.sweepEvents(
			bounded(tenantId, 'tenantId', 1, 128),
			cutoff.getTime(),
			Math.min(Math.max(Math.trunc(limit), 1), MAX_SWEEP_BATCH),
		);
	}

	/**
	 * Every provisioning event of one workspace, walked by the storage sequence
	 * so no page holds more than `pageSize` rows whatever the history is.
	 */
	async exportEvents(
		tenantId: string,
		sink: DataClassExportSink,
		pageSize = EXPORT_PAGE,
	): Promise<DataClassExportSummary> {
		const owner = bounded(tenantId, 'tenantId', 1, 128);
		let afterSequence = 0;
		let rows = 0;
		let from: number | null = null;
		let to: number | null = null;
		for (;;) {
			const page = await this.repository.exportEventsPage(
				owner,
				afterSequence,
				pageSize,
			);
			for (const event of page) {
				await sink.write({
					id: event.id,
					sequence: event.sequence,
					tokenId: event.tokenId,
					operation: event.operation,
					subject: event.subject,
					outcome: event.outcome,
					reason: event.reason,
					occurredAt: new Date(event.occurredAt).toISOString(),
				});
				rows += 1;
				if (from === null || event.occurredAt < from) from = event.occurredAt;
				if (to === null || event.occurredAt > to) to = event.occurredAt;
			}
			if (page.length < pageSize) break;
			afterSequence = page[page.length - 1]!.sequence;
		}
		return {
			rows,
			from: from === null ? null : new Date(from),
			to: to === null ? null : new Date(to),
		};
	}

	async #write(
		tenantId: string,
		group: ScimGroupMapping,
		roleKey: string | null,
		precedence: number,
	): Promise<void> {
		try {
			await this.repository.updateGroup({
				tenantId,
				id: group.id,
				externalId: group.externalId,
				displayName: group.displayName,
				roleKey,
				precedence,
				updatedAt: this.now(),
			});
		} catch (error) {
			if (error instanceof DirectoryUniqueViolation) {
				throw new DirectoryServiceError(
					'GROUP_EXISTS',
					'A group with this name already exists in the workspace.',
					409,
				);
			}
			throw error;
		}
	}

	/* One query resolves the winning role of every member of the group, so the
	   pass costs one read plus one write per member whose role actually moves. */
	async #recalculate(
		actor: AuthActor,
		groupId: string,
		roles: ReadonlySet<string>,
		defaultRole: string,
	): Promise<void> {
		const members = await this.repository.resolvedRolesForGroup(
			actor.tenantId,
			groupId,
		);
		if (members.length === 0) return;
		/* A disabled membership holds no role anyone can act on, and auth.core
		   counts it out of the owner tally, so recomputing it would refuse a
		   change the workspace can make. */
		const held = new Map(
			(await this.auth.listMembers(actor.tenantId))
				.filter((member) => member.membershipStatus === 'active')
				.map((member) => [member.accountId, member.role]),
		);
		const applied: { accountId: string; previous: string }[] = [];
		try {
			for (const member of members) {
				const target = member.roleKey ?? defaultRole;
				if (!roles.has(target)) {
					throw new DirectoryServiceError(
						'ROLE_UNKNOWN',
						`The role "${target}" does not exist in this workspace.`,
					);
				}
				const current = held.get(member.accountId);
				if (current === undefined || current === target) continue;
				await this.auth.assignRole(actor, member.accountId, target);
				applied.push({ accountId: member.accountId, previous: current });
			}
		} catch (error) {
			for (const change of applied.reverse()) {
				await this.auth
					.assignRole(actor, change.accountId, change.previous)
					.catch(() => undefined);
			}
			throw translateAuthError(error);
		}
	}
}

/**
 * Every auth.core refusal this module reports, and the code it reports it as.
 * The set is closed: a screen translates the codes listed here, and a code
 * auth.core adds later must not reach a reader as untranslated server text.
 */
const AUTH_REFUSALS: Readonly<
	Record<string, readonly [code: string, message: string, status: number]>
> = {
	LAST_OWNER: [
		'LAST_OWNER',
		'A workspace must keep at least one active owner.',
		409,
	],
	ROLE_NOT_FOUND: [
		'ROLE_UNKNOWN',
		'The role does not exist in this workspace.',
		400,
	],
	ACCOUNT_NOT_FOUND: [
		'MEMBER_NOT_FOUND',
		'The account is no longer a member of this workspace.',
		404,
	],
};

/** auth.core refusals reach the screen as this module's own stable codes. */
export function translateAuthError(error: unknown): unknown {
	if (!(error instanceof AuthServiceError)) return error;
	/* A fault of auth.core stays a fault: answering it as a refusal would tell
	   the reader their change was rejected when nothing decided it. */
	if (error.status >= 500) return error;
	const known = AUTH_REFUSALS[error.code];
	if (known) return new DirectoryServiceError(known[0], known[1], known[2]);
	return new DirectoryServiceError(
		'DIRECTORY_REFUSED',
		'The workspace directory refused the change.',
		error.status,
	);
}
