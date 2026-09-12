import type { ConnectorInstance } from '../domain/types.ts';

/** The caller kinds an owner consents to, one switch each. */
export const CONNECTOR_CALLER_KINDS = ['workflows', 'agents'] as const;
export type ConnectorCallerKind = (typeof CONNECTOR_CALLER_KINDS)[number];

export interface ConnectorConsentValue {
	readonly allowWorkflows: boolean;
	readonly allowAgents: boolean;
}

/** What the instance currently grants one caller kind. */
export function consentGranted(
	instance: ConnectorConsentValue,
	kind: ConnectorCallerKind,
): boolean {
	return kind === 'workflows' ? instance.allowWorkflows : instance.allowAgents;
}

/**
 * The payload that moves one caller kind and nothing else. The consent endpoint
 * takes both flags, so the kind that was not touched is sent exactly as the
 * instance holds it: turning workflows on can never turn agents on with it.
 */
export function consentChange(
	instance: ConnectorConsentValue,
	kind: ConnectorCallerKind,
	next: boolean,
): ConnectorConsentValue {
	return {
		allowWorkflows: kind === 'workflows' ? next : instance.allowWorkflows,
		allowAgents: kind === 'agents' ? next : instance.allowAgents,
	};
}

/** The state the drawer is in, so it never renders a form over nothing. */
export type ConnectorFormState = 'loading' | 'denied' | 'missing' | 'ready';

export function connectorFormState(input: {
	readonly status: 'idle' | 'loading' | 'submitting' | 'denied' | 'error';
	readonly selectedId: string;
	readonly instance: ConnectorInstance | null;
}): ConnectorFormState {
	if (input.status === 'denied') return 'denied';
	if (input.selectedId === '') return 'ready';
	if (input.instance) return 'ready';
	return input.status === 'loading' ? 'loading' : 'missing';
}
