import type {
	SandboxAccessGrant,
	SandboxSessionState,
} from '../domain/types.ts';
import { activeLocale, t } from '@flowdular/client/i18n';

export type GrantState = 'active' | 'expired' | 'revoked';

export function grantState(grant: SandboxAccessGrant, now: number): GrantState {
	if (grant.revokedAt !== null) return 'revoked';
	if (grant.expiresAt !== null && grant.expiresAt <= now) return 'expired';
	return 'active';
}

export function grantTone(
	state: GrantState,
): 'success' | 'warning' | 'neutral' {
	if (state === 'active') return 'success';
	return state === 'expired' ? 'warning' : 'neutral';
}

export function sessionTone(
	state: SandboxSessionState,
): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
	if (state === 'accepted') return 'success';
	if (state === 'failed' || state === 'blocked') return 'danger';
	if (state === 'awaiting-approval') return 'warning';
	if (state === 'draft' || state === 'archived' || state === 'deleted') {
		return 'neutral';
	}
	return 'info';
}

export function capabilityLabel(capability: string): string {
	const key = 'sandbox.capability.' + capability;
	const translated = t(key);
	return translated === key
		? capability.replace('sandbox.', '').replace(/\./g, ' ')
		: translated;
}

export function timestamp(value: number): string {
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(value));
}
