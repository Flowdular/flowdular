import type { TableEmpty, TagTone } from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client/i18n';
import type {
	ProvisioningOperation,
	ProvisioningOutcome,
	ScimToken,
	ScimTokenStatus,
} from '../domain/types.ts';
import type { ScreenStatus } from './state.ts';

function formatted(value: number): string {
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(value);
}

/** Epoch milliseconds as the reader's local date and time. */
export function timestampLabel(value: number | null): string {
	if (value === null) return t('directory.common.never');
	return formatted(value);
}

/** What a row says a token is, which an expiry can differ from its status on. */
export type TokenDisplayStatus = ScimTokenStatus | 'expired';

/**
 * An active token past its expiry authenticates nothing, and rotation carries
 * the stored expiry forward, so the row names the expiry rather than showing
 * the stored status alone.
 */
export function tokenDisplayStatus(
	token: Pick<ScimToken, 'status' | 'expiresAt'>,
	at: number = Date.now(),
): TokenDisplayStatus {
	return token.status === 'active' &&
		token.expiresAt !== null &&
		token.expiresAt <= at
		? 'expired'
		: token.status;
}

export function tokenStatusLabel(status: TokenDisplayStatus): string {
	return t('directory.tokens.status.' + status);
}

export function tokenStatusTone(status: TokenDisplayStatus): TagTone {
	if (status === 'active') return 'success';
	return status === 'expired' ? 'warning' : 'neutral';
}

export function operationLabel(operation: ProvisioningOperation): string {
	return t('directory.log.operation.' + operation);
}

export function outcomeLabel(outcome: ProvisioningOutcome): string {
	return t('directory.log.outcome.' + outcome);
}

export function outcomeTone(outcome: ProvisioningOutcome): TagTone {
	if (outcome === 'applied') return 'success';
	return outcome === 'unchanged' ? 'neutral' : 'danger';
}

/** A refusal code is stable server text; unknown codes stay readable as they are. */
export function reasonLabel(reason: string | null): string {
	if (reason === null || reason === '') return '';
	const key = 'directory.reason.' + reason;
	const translated = t(key);
	return translated === key ? reason : translated;
}

/** A local `datetime-local` value as epoch milliseconds, or null when empty. */
export function expiryToTimestamp(value: string): number | null {
	if (value.trim() === '') return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function pad(part: number): string {
	return String(part).padStart(2, '0');
}

/**
 * Epoch milliseconds as the `YYYY-MM-DDTHH:mm` a datetime field carries. The
 * parts are read in the reader's own zone, because the control holds a local
 * wall-clock reading and never an instant.
 */
export function expiryFieldValue(value: number): string {
	const at = new Date(value);
	return (
		`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
		`T${pad(at.getHours())}:${pad(at.getMinutes())}`
	);
}

/**
 * What a table renders in place of its rows. A load that failed must never
 * answer with the empty state: "nothing here yet" is a statement about the
 * workspace, and a failed request read nothing to make it from.
 */
export function tableEmpty(
	status: ScreenStatus,
	populated: TableEmpty,
): TableEmpty {
	if (status !== 'error') return populated;
	return {
		icon: 'alert',
		title: t('directory.common.loadFailed'),
		hint: t('directory.common.loadFailedHint'),
	};
}
