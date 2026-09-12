import { TENANT_TIME_ZONE_SETTING } from '@flowdular/contracts';
import type { ModuleSettingsRuntime } from '@flowdular/kernel';

/* This module declares the setting; the shared contract names it, so a reader
   in another module addresses the same id, key and fallback. */
export const SYSTEM_MODULE_ID = TENANT_TIME_ZONE_SETTING.moduleId;
export const TENANT_TIME_ZONE_KEY = TENANT_TIME_ZONE_SETTING.key;
export const DEFAULT_TIME_ZONE = TENANT_TIME_ZONE_SETTING.defaultValue;
export const MAX_TIME_ZONE_LENGTH = 64;

/* A cheap shape filter in front of the Intl probe, so a hostile value never
   reaches the formatter and never enters the accepted set below. */
export const TIME_ZONE_PATTERN =
	'[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+){0,2}';

const SHAPE = new RegExp(`^(?:${TIME_ZONE_PATTERN})$`);

export class InvalidTimeZoneError extends Error {
	readonly code = 'INVALID_TIME_ZONE';

	constructor() {
		super(
			`Time zone must be an IANA zone name such as Europe/Warsaw, at most ${MAX_TIME_ZONE_LENGTH} characters.`,
		);
		this.name = 'InvalidTimeZoneError';
	}
}

/* Canonical names the runtime accepted, keyed by the lower-cased candidate so
   every spelling of a zone shares one entry. Capped like the formatter cache in
   automations: a deployment works in a handful of zones, and the cap keeps a
   long-lived process from carrying every spelling it was ever sent. */
const MAX_ACCEPTED_ZONES = 32;
const accepted = new Map<string, string>();

function probe(value: string): string | null {
	try {
		return new Intl.DateTimeFormat('en-US', {
			timeZone: value,
		}).resolvedOptions().timeZone;
	} catch {
		return null;
	}
}

/** The canonical IANA name, or null when this runtime does not know the zone. */
export function resolveTimeZone(value: string): string | null {
	const candidate = value.trim();
	if (candidate.length === 0 || candidate.length > MAX_TIME_ZONE_LENGTH) {
		return null;
	}
	if (!SHAPE.test(candidate)) return null;
	const spelling = candidate.toLowerCase();
	const cached = accepted.get(spelling);
	if (cached !== undefined) return cached;
	const canonical = probe(candidate);
	if (canonical === null) return null;
	if (accepted.size >= MAX_ACCEPTED_ZONES) accepted.clear();
	accepted.set(spelling, canonical);
	return canonical;
}

export function isSupportedTimeZone(value: string): boolean {
	return resolveTimeZone(value) !== null;
}

/** The canonical name to store, or `InvalidTimeZoneError` for anything else. */
export function normalizeTimeZone(value: string): string {
	const canonical = resolveTimeZone(value);
	if (canonical === null) throw new InvalidTimeZoneError();
	return canonical;
}

/**
 * The workspace time zone any module may read. A stored value this runtime no
 * longer knows falls back to UTC rather than failing the caller, because the
 * readers are schedulers and formatters that must keep working.
 */
export function tenantTimeZone(
	settings: ModuleSettingsRuntime,
	tenantId: string,
): string {
	let stored: string;
	try {
		stored = settings.get<string>(
			tenantId,
			SYSTEM_MODULE_ID,
			TENANT_TIME_ZONE_KEY,
		);
	} catch {
		/* system.core is not composed in this deployment. */
		return DEFAULT_TIME_ZONE;
	}
	return resolveTimeZone(stored) ?? DEFAULT_TIME_ZONE;
}
