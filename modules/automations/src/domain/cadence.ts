import {
	InvalidCronError,
	MAX_CRON_LENGTH,
	nextCronSlot,
	normalizeCron,
	parseCron,
	type CronFields,
} from './cron.ts';

export { MAX_CRON_LENGTH } from './cron.ts';

export const MIN_CADENCE_MINUTES = 1;
export const MAX_CADENCE_MINUTES = 10_080;
export const CRON_PREFIX = 'cron:';
export const MAX_CADENCE_LENGTH = CRON_PREFIX.length + MAX_CRON_LENGTH;

const CADENCE_PATTERN = /^every:(\d{1,5})$/;

export type Cadence =
	| { readonly kind: 'every'; readonly minutes: number }
	| {
			readonly kind: 'cron';
			readonly expression: string;
			readonly fields: CronFields;
	  };

export class InvalidCadenceError extends Error {
	constructor(detail?: string) {
		super(
			detail ??
				`Cadence must be "every:<minutes>" with ${MIN_CADENCE_MINUTES} to ${MAX_CADENCE_MINUTES} minutes, or "cron:<minute> <hour> <day of month> <month> <day of week>".`,
		);
		this.name = 'InvalidCadenceError';
	}
}

/** Which form a stored cadence uses, without parsing or throwing. */
export function cadenceKind(value: string): Cadence['kind'] {
	return value.trim().toLowerCase().startsWith(CRON_PREFIX) ? 'cron' : 'every';
}

export function cadenceMinutes(value: string): number {
	const match = CADENCE_PATTERN.exec(value.trim().toLowerCase());
	const minutes = match ? Number(match[1]) : NaN;
	if (
		!Number.isSafeInteger(minutes) ||
		minutes < MIN_CADENCE_MINUTES ||
		minutes > MAX_CADENCE_MINUTES
	) {
		throw new InvalidCadenceError();
	}
	return minutes;
}

export function cronExpression(value: string): string {
	const trimmed = value.trim();
	return cadenceKind(trimmed) === 'cron'
		? trimmed.slice(CRON_PREFIX.length)
		: '';
}

export function parseCadence(value: string): Cadence {
	if (value.length > MAX_CADENCE_LENGTH) {
		throw new InvalidCadenceError('The cadence is too long.');
	}
	if (cadenceKind(value) === 'every') {
		return { kind: 'every', minutes: cadenceMinutes(value) };
	}
	const raw = cronExpression(value);
	try {
		return {
			kind: 'cron',
			expression: normalizeCron(raw),
			fields: parseCron(raw),
		};
	} catch (error) {
		if (error instanceof InvalidCronError) {
			throw new InvalidCadenceError(error.message);
		}
		throw error;
	}
}

export function normalizeCadence(value: string): string {
	const cadence = parseCadence(value);
	return cadence.kind === 'every'
		? `every:${cadence.minutes}`
		: `${CRON_PREFIX}${cadence.expression}`;
}

/* The first slot after `firedAt` that is still in the future. Missed slots are
   skipped rather than replayed: a worker that was down for an hour must not
   queue sixty runs the moment it comes back. */
export function nextSlotAfter(
	firedAt: number,
	minutes: number,
	now: number,
): number {
	const interval = minutes * 60_000;
	if (firedAt > now) return firedAt;
	const steps = Math.floor((now - firedAt) / interval) + 1;
	return firedAt + steps * interval;
}

function cronSlotAfter(
	cadence: Extract<Cadence, { kind: 'cron' }>,
	after: number,
	timeZone: string,
): number {
	const slot = nextCronSlot(cadence.fields, after, timeZone);
	if (slot === null) {
		throw new InvalidCadenceError(
			`Cron expression ${cadence.expression} matches no date.`,
		);
	}
	return slot;
}

/** The first slot of a cadence that was just saved or re-timed. */
export function firstCadenceSlot(
	cadence: Cadence,
	now: number,
	timeZone: string,
): number {
	return cadence.kind === 'every'
		? now + cadence.minutes * 60_000
		: cronSlotAfter(cadence, now, timeZone);
}

/** The slot that follows the one just fired, with missed slots skipped. */
export function nextCadenceSlot(
	cadence: Cadence,
	firedSlot: number,
	now: number,
	timeZone: string,
): number {
	return cadence.kind === 'every'
		? nextSlotAfter(firedSlot, cadence.minutes, now)
		: cronSlotAfter(cadence, Math.max(firedSlot, now), timeZone);
}
