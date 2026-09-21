import {
	DECISION_PROVIDER_CATALOG,
	DECISION_PROVIDER_KINDS,
	type DecisionProviderKind,
} from '@flowdular/ai-provider';
import { sealSecret, type DecisionConfiguration } from './config.ts';
import { SandboxSetupError } from './workspace-root.ts';

function isDecisionKind(value: string): value is DecisionProviderKind {
	return (DECISION_PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * The decision provider patch of a configuration request. Returns undefined
 * when the request says nothing about it, null when it is removed.
 */
export async function decisionSettings(
	root: string,
	value: Record<string, unknown>,
	previous: DecisionConfiguration | null,
): Promise<DecisionConfiguration | null | undefined> {
	if (value.decisionsRemove === true) return null;
	const touched =
		value.decisionsEnabled !== undefined ||
		value.decisionsKind !== undefined ||
		value.decisionsModel !== undefined ||
		value.decisionsCredential !== undefined ||
		value.decisionsClearCredential === true;
	if (!touched) return undefined;
	const field = (name: string, max: number): string => {
		const at = value[name];
		if (at === undefined || at === null) return '';
		if (typeof at !== 'string' || at.length > max)
			throw new SandboxSetupError('INVALID_INPUT', `Invalid ${name}.`);
		return at.trim();
	};
	const kindValue = field('decisionsKind', 40);
	if (kindValue && !isDecisionKind(kindValue)) {
		throw new SandboxSetupError('INVALID_INPUT', 'Unknown decision provider.');
	}
	const kind: DecisionProviderKind = isDecisionKind(kindValue)
		? kindValue
		: (previous?.kind ?? 'typesafe');
	const model =
		field('decisionsModel', 160) ||
		previous?.model ||
		DECISION_PROVIDER_CATALOG[kind].defaultModel;
	if (
		value.decisionsEnabled !== undefined &&
		typeof value.decisionsEnabled !== 'boolean'
	) {
		throw new SandboxSetupError('INVALID_INPUT', 'Invalid decisionsEnabled.');
	}
	const credential = field('decisionsCredential', 16_384);
	/* A key stays with the destination it was sealed for, the same rule the
	   model settings follow. */
	const sameDestination = previous?.kind === kind;
	return {
		/* Turning it on is its own decision: configuring a model or a key never
		   starts sending session text on its own. */
		enabled:
			typeof value.decisionsEnabled === 'boolean'
				? value.decisionsEnabled
				: (previous?.enabled ?? false),
		kind,
		model,
		credential: credential
			? await sealSecret(root, credential)
			: value.decisionsClearCredential === true || !sameDestination
				? null
				: (previous?.credential ?? null),
	};
}
