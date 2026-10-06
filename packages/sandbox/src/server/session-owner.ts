import {
	holdsLauncherCredential,
	updateSandboxConfiguration,
	type SandboxConfiguration,
} from './config.ts';
import { withSessionLock } from './session-lock.ts';
import {
	listSessions,
	readSession,
	writeSession,
	type SandboxSession,
	type SessionOwner,
} from './sessions.ts';

export function ownsSession(
	session: SandboxSession,
	owner: SessionOwner | null,
): boolean {
	return Boolean(
		owner &&
			session.owner &&
			session.owner.accountId === owner.accountId &&
			session.owner.tenantId === owner.tenantId &&
			session.owner.platformUrl.replace(/\/+$/, '') ===
				owner.platformUrl.replace(/\/+$/, ''),
	);
}

export function canReadSession(
	session: SandboxSession,
	owner: SessionOwner | null,
	local: boolean,
): boolean {
	return ownsSession(session, owner) || (local && !session.owner);
}

/* Gives the sessions one account owns under earlier platform addresses to its
   current address. Each record is replaced on its own and keeps its place in
   the list, and a record already moved no longer matches, so running this
   again after an interruption moves only what is left. */
async function moveSessionOwner(
	workspaceRoot: string,
	move: {
		readonly from: readonly string[];
		readonly to: string;
		readonly tenantId: string;
		readonly accountId: string;
	},
): Promise<number> {
	const trimmed = (url: string) => url.replace(/\/+$/, '');
	const from = new Set(move.from.map(trimmed));
	from.delete(trimmed(move.to));
	const matches = (owner: SessionOwner | undefined): owner is SessionOwner =>
		owner !== undefined &&
		owner.tenantId === move.tenantId &&
		owner.accountId === move.accountId &&
		from.has(trimmed(owner.platformUrl));
	let moved = 0;
	for (const listed of await listSessions(workspaceRoot, true)) {
		if (!matches(listed.owner)) continue;
		await withSessionLock(workspaceRoot, listed.id, async () => {
			const current = await readSession(workspaceRoot, listed.id);
			if (!matches(current.owner)) return;
			await writeSession(workspaceRoot, {
				...current,
				owner: { ...current.owner, platformUrl: move.to },
			});
			moved++;
		});
	}
	return moved;
}

/* The second half of the move recordPlatformAddress starts. Whose sessions
   travel with the launcher's credential is known only once the platform has
   answered for it, so the connection that proves the account moves them and
   only then drops the addresses. An operator's credential moves nothing. This
   never throws: a failed move leaves the connection alone and the next
   connection tries again. */
export async function completeSessionMove(options: {
	readonly workspaceRoot: string;
	readonly configuration: SandboxConfiguration;
	readonly principal: { readonly tenantId: string; readonly accountId: string };
	readonly log: (line: string) => void;
}): Promise<SandboxConfiguration> {
	const { configuration } = options;
	const pending = configuration.pendingSessionMoveFrom;
	if (pending.length === 0 || !holdsLauncherCredential(configuration))
		return configuration;
	try {
		const moved = await moveSessionOwner(options.workspaceRoot, {
			from: pending,
			to: configuration.platformUrl,
			tenantId: options.principal.tenantId,
			accountId: options.principal.accountId,
		});
		/* Read again: the operator may have saved settings while the sessions
		   moved, and only the addresses finished here are this step's to drop. */
		await updateSandboxConfiguration(options.workspaceRoot, (latest) => ({
			...latest,
			pendingSessionMoveFrom: latest.pendingSessionMoveFrom.filter(
				(url) => !pending.includes(url),
			),
		}));
		if (moved > 0)
			options.log(
				`moved ${moved} sandbox session${moved === 1 ? '' : 's'} from ${pending.join(', ')} to ${configuration.platformUrl}`,
			);
		return { ...configuration, pendingSessionMoveFrom: [] };
	} catch (error) {
		options.log(
			`could not move the sandbox sessions to ${configuration.platformUrl}: ${
				error instanceof Error ? error.message.split('\n')[0] : String(error)
			}`,
		);
		return configuration;
	}
}
