export const MIN_CADENCE_MINUTES = 1;
export const MAX_CADENCE_MINUTES = 10_080;

const CADENCE_PATTERN = /^every:(\d{1,5})$/;

export class InvalidCadenceError extends Error {
	constructor() {
		super(
			`Cadence must be "every:<minutes>" with ${MIN_CADENCE_MINUTES} to ${MAX_CADENCE_MINUTES} minutes.`,
		);
		this.name = 'InvalidCadenceError';
	}
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

export function normalizeCadence(value: string): string {
	return `every:${cadenceMinutes(value)}`;
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
