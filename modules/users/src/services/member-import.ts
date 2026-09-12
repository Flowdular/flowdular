import type { AuthPrincipal, TenantMember } from '@flowdular/module-auth';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	AuthServiceError,
	TENANT_MEMBER_LOOKUP_LIMIT,
} from '@flowdular/module-auth/server';
import type {
	ImportPort,
	ImportRow,
	ImportValidateInput,
	ImportValidation,
	ImportWriteInput,
	ImportWriteOutcome,
} from '@flowdular/module-import';
import { USER_PERMISSIONS } from '../acl/permissions.ts';
import { UsersService } from './users-service.ts';

/** The port key; import.core composes the target id `users.core.members`. */
export const MEMBER_IMPORT_PORT_KEY = 'members';

/** A row that names no role joins on the least privileged built-in role. */
export const MEMBER_IMPORT_DEFAULT_ROLE = 'member';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* The address rule auth.core applies, so the natural key this port looks up is
   the same string auth.core stored. */
function address(value: string | undefined): string {
	return (value ?? '').trim().normalize('NFKC').toLowerCase();
}

function text(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function refusal(row: number, field: string, reason: string): ImportValidation {
	return { row, verdict: 'invalid', field, reason };
}

/**
 * Refusals only, as the port contract asks: a row this says nothing about is
 * taken as valid. Whether a member already exists is not one of them, because
 * the job's mode decides what an existing member means, and that is read at
 * write time.
 */
async function validateRows(
	auth: AuthRuntime,
	{ tenantId, rows }: ImportValidateInput,
): Promise<readonly ImportValidation[]> {
	const roles = new Set(
		(await (await auth.service()).listRoles(tenantId)).map((role) => role.key),
	);
	const refusals: ImportValidation[] = [];
	const seen = new Set<string>();
	for (const entry of rows) {
		const email = address(entry.values.email);
		if (email.length > 254 || !EMAIL.test(email)) {
			refusals.push(refusal(entry.row, 'email', 'EMAIL_INVALID'));
			continue;
		}
		const displayName = text(entry.values.displayName);
		if (
			displayName === undefined ||
			displayName.length < 2 ||
			displayName.length > 80
		) {
			refusals.push(refusal(entry.row, 'displayName', 'DISPLAY_NAME_INVALID'));
			continue;
		}
		const role = text(entry.values.role);
		if (role !== undefined && !roles.has(role)) {
			refusals.push(refusal(entry.row, 'role', 'ROLE_UNKNOWN'));
			continue;
		}
		/* The first row carrying an address is the one that writes it, so a
		   repeat further down the file would write over this import's own row.
		   A repeat in a later batch meets the natural key at write instead. */
		if (seen.has(email)) {
			refusals.push(refusal(entry.row, 'email', 'EMAIL_DUPLICATE'));
			continue;
		}
		seen.add(email);
	}
	return refusals;
}

/* No credential at all: auth.core stores its unusable marker, so nothing has to
   be drawn, kept, or thrown away here. The member reaches the workspace through
   the public reset flow or an administrative temporary password. */
async function createMember(
	users: UsersService,
	principal: AuthPrincipal,
	entry: ImportRow,
	email: string,
): Promise<ImportWriteOutcome> {
	const created = await users.createWithoutPassword(principal, {
		email,
		displayName: text(entry.values.displayName) ?? '',
		role: text(entry.values.role) ?? MEMBER_IMPORT_DEFAULT_ROLE,
	});
	return { row: entry.row, outcome: 'created', recordRef: created.accountId };
}

async function applyExisting(
	users: UsersService,
	principal: AuthPrincipal,
	entry: ImportRow,
	member: TenantMember,
	mode: ImportWriteInput['mode'],
): Promise<ImportWriteOutcome> {
	if (mode === 'create-only') {
		return { row: entry.row, outcome: 'failed', reason: 'ALREADY_EXISTS' };
	}
	if (mode === 'skip-existing') {
		return { row: entry.row, outcome: 'skipped', recordRef: member.accountId };
	}
	/* There is no transaction across the two writes, so the display name goes
	   first: it is the bounded one, refused only for its own shape, while the
	   role meets the owner cap, the acting principal and the assignable set. A
	   value the member already holds is not written at all, so a repeat leaves
	   no audit event for a change that did not happen. */
	const displayName = text(entry.values.displayName);
	let renamed = false;
	if (displayName !== undefined && displayName !== member.displayName) {
		await users.rename(principal, member.accountId, displayName);
		renamed = true;
	}
	const role = text(entry.values.role);
	if (role !== undefined && role !== member.role) {
		try {
			await users.assignRole(principal, member.accountId, role);
		} catch (error) {
			/* The rename already landed. Failing the whole row here would report a
			   change that did happen as one that did not, so the row is updated and
			   names what the role write met. */
			if (!renamed) throw error;
			return {
				row: entry.row,
				outcome: 'updated',
				recordRef: member.accountId,
				reason: `ROLE_UNCHANGED:${
					error instanceof AuthServiceError ? error.code : 'WRITE_FAILED'
				}`,
			};
		}
	}
	return { row: entry.row, outcome: 'updated', recordRef: member.accountId };
}

/**
 * The batch's natural keys, resolved by the addresses the batch names rather
 * than by listing the workspace: the cost is the rows the file asks about, not
 * the workspace's member count. auth.core bounds one lookup, and an import
 * batch is a setting a deployment raises, so the addresses are split into
 * chunks of that bound.
 */
async function existingMembers(
	auth: AuthRuntime,
	tenantId: string,
	addresses: readonly string[],
): Promise<Map<string, TenantMember>> {
	const service = await auth.service();
	const found = new Map<string, TenantMember>();
	const wanted = [...new Set(addresses)];
	for (
		let start = 0;
		start < wanted.length;
		start += TENANT_MEMBER_LOOKUP_LIMIT
	) {
		for (const member of await service.findTenantMembersByEmail(
			tenantId,
			wanted.slice(start, start + TENANT_MEMBER_LOOKUP_LIMIT),
		)) {
			found.set(address(member.email), member);
		}
	}
	return found;
}

/**
 * One outcome per row. The read names the job's workspace while every write
 * pins the tenant to the principal, so a disagreement between the two fails the
 * row in auth.core instead of reaching another workspace.
 */
async function writeRows(
	auth: AuthRuntime,
	users: UsersService,
	{ tenantId, principal, rows, mode }: ImportWriteInput,
): Promise<readonly ImportWriteOutcome[]> {
	const existing = await existingMembers(
		auth,
		tenantId,
		rows.map((entry) => address(entry.values.email)).filter(Boolean),
	);
	const outcomes: ImportWriteOutcome[] = [];
	for (const entry of rows) {
		const email = address(entry.values.email);
		const member = existing.get(email);
		try {
			outcomes.push(
				member === undefined
					? await createMember(users, principal, entry, email)
					: await applyExisting(users, principal, entry, member, mode),
			);
		} catch (error) {
			/* One row never fails the batch, and only the stable code is reported:
			   an auth.core message can name the member it refused. */
			outcomes.push({
				row: entry.row,
				outcome: 'failed',
				reason: error instanceof AuthServiceError ? error.code : 'WRITE_FAILED',
			});
		}
	}
	return outcomes;
}

/**
 * The workspace's members as an import target. Every read and write goes
 * through the auth administration port with the principal that started the job
 * as the actor, so the owner cap, the last-owner rule and the audit trail hold
 * for an imported row exactly as they do for the Users screen.
 */
export function createMemberImportPort(auth: AuthRuntime): ImportPort {
	const users = new UsersService(auth);
	return {
		key: MEMBER_IMPORT_PORT_KEY,
		label: 'Members',
		permission: USER_PERMISSIONS.manage,
		fields: [
			{ id: 'email', label: 'Email', required: true, type: 'email' },
			{
				id: 'displayName',
				label: 'Display name',
				required: true,
				type: 'string',
			},
			{ id: 'role', label: 'Role', required: false, type: 'string' },
		],
		naturalKey: ['email'],
		/* The address rule auth.core stores under, so two rows naming one member
		   in different case are one natural key for the whole file, not only
		   inside the batch the port happens to see them in. */
		naturalKeyOf: (values) => address(values.email),
		validate: (input) => validateRows(auth, input),
		write: (input) => writeRows(auth, users, input),
	};
}
