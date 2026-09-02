export type ActorKind = 'user' | 'agent' | 'service';

interface ActorIdentity {
	readonly id: string;
	readonly label: string;
}

export interface UserActor extends ActorIdentity {
	readonly kind: 'user';
	readonly runId?: never;
}

export interface AgentActor extends ActorIdentity {
	readonly kind: 'agent';
	/* Every agent mutation remains traceable to the run that authorized it. */
	readonly runId: string;
}

export interface ServiceActor extends ActorIdentity {
	readonly kind: 'service';
	/* A service acts with authority configured by a real account. Keeping the
	   user here prevents schedules and webhooks from becoming anonymous system
	   actors in record history. */
	readonly configuredBy: UserActor;
}

/* Audit and record-history surfaces use one discriminated actor model. The
   required runId prevents an agent from being stored as an anonymous user-like
   label while keeping user records free of synthetic run identifiers. */
export type Actor = UserActor | AgentActor | ServiceActor;

export const MAX_ACTOR_ID_LENGTH = 128;
export const MAX_ACTOR_LABEL_LENGTH = 160;

/* Older tool callers may still provide only a run identifier. New harness
   calls also carry the exact agent identity. */
export interface AgentActorSource {
	readonly runId: string;
	readonly agentId?: string;
	readonly agentName?: string;
}

export interface UserActorSource {
	readonly accountId: string;
	readonly displayName?: string;
	readonly email: string;
}

export interface ServiceActorSource {
	readonly serviceId: string;
	readonly label: string;
	readonly configuredBy: UserActor | UserActorSource;
}

function trimmed(value: string | undefined): string {
	return typeof value === 'string' ? value.trim() : '';
}

export function agentActor(source: AgentActorSource): Actor {
	const runId = trimmed(source.runId);
	return {
		kind: 'agent',
		id: trimmed(source.agentId) || runId,
		label: trimmed(source.agentName) || `Agent run ${runId}`,
		runId,
	};
}

export function userActor(source: UserActorSource): UserActor {
	const accountId = trimmed(source.accountId);
	const displayName = trimmed(source.displayName);
	const email = trimmed(source.email);
	return {
		kind: 'user',
		id: accountId,
		label: displayName || email,
	};
}

export function serviceActor(source: ServiceActorSource): ServiceActor {
	const configuredBy =
		'kind' in source.configuredBy
			? source.configuredBy
			: userActor(source.configuredBy);
	return {
		kind: 'service',
		id: trimmed(source.serviceId),
		label: trimmed(source.label),
		configuredBy,
	};
}

/* Returns null instead of throwing so each service reports the refusal with
   its own error code. */
export function normalizeActor(actor: Actor): Actor | null {
	if (
		actor.kind !== 'user' &&
		actor.kind !== 'agent' &&
		actor.kind !== 'service'
	)
		return null;
	const id = trimmed(actor.id);
	const label = trimmed(actor.label);
	if (id.length === 0 || id.length > MAX_ACTOR_ID_LENGTH) return null;
	if (label.length === 0 || label.length > MAX_ACTOR_LABEL_LENGTH) return null;
	if (actor.kind === 'agent') {
		const runId = trimmed(actor.runId);
		if (runId.length === 0 || runId.length > MAX_ACTOR_ID_LENGTH) return null;
		return { kind: 'agent', id, label, runId };
	}
	if (actor.kind === 'service') {
		const configuredBy = normalizeActor(actor.configuredBy);
		if (!configuredBy || configuredBy.kind !== 'user') return null;
		return { kind: 'service', id, label, configuredBy };
	}
	return { kind: 'user', id, label };
}

/* Labels are presentation data and may change. Authority is the actor kind and
   stable id, plus the provenance that makes agent and service actors traceable. */
export function actorsEqual(left: Actor, right: Actor): boolean {
	const normalizedLeft = normalizeActor(left);
	const normalizedRight = normalizeActor(right);
	if (
		!normalizedLeft ||
		!normalizedRight ||
		normalizedLeft.kind !== normalizedRight.kind ||
		normalizedLeft.id !== normalizedRight.id
	) {
		return false;
	}
	if (normalizedLeft.kind === 'agent' && normalizedRight.kind === 'agent') {
		return normalizedLeft.runId === normalizedRight.runId;
	}
	if (normalizedLeft.kind === 'service' && normalizedRight.kind === 'service') {
		return normalizedLeft.configuredBy.id === normalizedRight.configuredBy.id;
	}
	return normalizedLeft.kind === 'user' && normalizedRight.kind === 'user';
}
