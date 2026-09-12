import { describe, expect, it } from 'vitest';
import { TENANT_TIME_ZONE_SETTING } from '@flowdular/contracts';
import {
	createModuleSettingsRuntime,
	type ModuleSettingsStore,
	type ModuleSettingValue,
} from '@flowdular/kernel';
import { SYSTEM_MODULE_SETTINGS } from '../src/settings.ts';
import {
	DEFAULT_TIME_ZONE,
	InvalidTimeZoneError,
	isSupportedTimeZone,
	normalizeTimeZone,
	resolveTimeZone,
	SYSTEM_MODULE_ID,
	TENANT_TIME_ZONE_KEY,
	TIME_ZONE_PATTERN,
	tenantTimeZone,
} from '../src/domain/time-zone.ts';

function memoryStore(): ModuleSettingsStore {
	const values = new Map<string, Record<string, ModuleSettingValue>>();
	const keyOf = (tenantId: string, moduleId: string) =>
		`${tenantId} ${moduleId}`;
	return {
		load: (tenantId, moduleId) => values.get(keyOf(tenantId, moduleId)) ?? {},
		save: (record) => {
			const key = keyOf(record.tenantId, record.moduleId);
			values.set(key, { ...values.get(key), [record.key]: record.value });
		},
		clear: (tenantId, moduleId, key) => {
			const stored = values.get(keyOf(tenantId, moduleId));
			if (stored) delete stored[key];
		},
	};
}

function runtime() {
	const settings = createModuleSettingsRuntime(memoryStore());
	settings.declare(SYSTEM_MODULE_SETTINGS);
	return settings;
}

const SHAPE = new RegExp(`^(?:${TIME_ZONE_PATTERN})$`);

/* Zones this runtime really has, so a case counts a probe of the zone database
   rather than a rejection by the shape filter in front of it. */
const ZONES = Intl.supportedValuesOf('timeZone').filter((zone) =>
	SHAPE.test(zone),
);

/** How many times the run reached the runtime zone database. */
function probeCount(run: () => void): number {
	const real = Intl.DateTimeFormat;
	let probes = 0;
	Intl.DateTimeFormat = new Proxy(real, {
		construct: (target, args, newTarget) => {
			probes += 1;
			return Reflect.construct(target, args, newTarget) as object;
		},
	});
	try {
		run();
	} finally {
		Intl.DateTimeFormat = real;
	}
	return probes;
}

describe('workspace time zone', () => {
	it('accepts an IANA zone and answers its canonical name', () => {
		expect(normalizeTimeZone('Europe/Warsaw')).toBe('Europe/Warsaw');
		expect(normalizeTimeZone(' europe/warsaw ')).toBe('Europe/Warsaw');
		expect(normalizeTimeZone('utc')).toBe('UTC');
		expect(isSupportedTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
	});

	it('refuses anything this runtime cannot resolve to a zone', () => {
		for (const value of [
			'',
			'   ',
			'Mars/Olympus',
			'Europe/Warsaw; DROP TABLE',
			'Europe/Warsaw/Extra/Deep',
			'../../etc/passwd',
			'E'.repeat(65),
		]) {
			expect(() => normalizeTimeZone(value), value).toThrowError(
				InvalidTimeZoneError,
			);
			expect(isSupportedTimeZone(value)).toBe(false);
		}
	});

	/* A caller may send a zone in as many spellings as it likes. They all name
	   one zone, so they cost one probe and one entry. */
	it('answers every spelling of a zone from one accepted entry', () => {
		const spellings = [
			'Europe/Warsaw',
			'europe/warsaw',
			'EUROPE/WARSAW',
			'EUROPE/warsaw',
			'europe/WARSAW',
			'eUrOpE/wArSaW',
		];
		const probes = probeCount(() => {
			for (const spelling of spellings) {
				expect(resolveTimeZone(spelling), spelling).toBe('Europe/Warsaw');
			}
		});
		expect(probes).toBeLessThanOrEqual(1);
	});

	/* The accepted names are a cache, not a directory of every zone the process
	   was ever asked about. */
	it('stops holding accepted zones once the cache is full', () => {
		expect(ZONES.length).toBeGreaterThan(40);
		const first = ZONES[0]!;
		for (const zone of ZONES.slice(0, 40)) {
			expect(resolveTimeZone(zone), zone).not.toBeNull();
		}
		expect(
			probeCount(() => {
				resolveTimeZone(first);
			}),
		).toBe(1);
	});

	it('reads UTC until a workspace sets its own zone', () => {
		const settings = runtime();
		expect(tenantTimeZone(settings, 'tenant-a')).toBe(DEFAULT_TIME_ZONE);
		settings.set(
			'tenant-a',
			SYSTEM_MODULE_ID,
			TENANT_TIME_ZONE_KEY,
			'Europe/Warsaw',
			'account-1',
		);
		expect(tenantTimeZone(settings, 'tenant-a')).toBe('Europe/Warsaw');
		/* Per workspace: another tenant keeps the default. */
		expect(tenantTimeZone(settings, 'tenant-b')).toBe(DEFAULT_TIME_ZONE);
	});

	it('falls back to UTC for a module that reads it before system.core composes', () => {
		const settings = createModuleSettingsRuntime(memoryStore());
		expect(tenantTimeZone(settings, 'tenant-a')).toBe(DEFAULT_TIME_ZONE);
	});

	/* The declared pattern bounds the shape only, so a name no zone database
	   knows can reach storage through a write that skipped the endpoint. */
	it('falls back to UTC for a stored zone this runtime does not know', () => {
		const settings = runtime();
		settings.set(
			'tenant-a',
			SYSTEM_MODULE_ID,
			TENANT_TIME_ZONE_KEY,
			'Mars/Olympus',
			'account-1',
		);
		expect(
			settings.get('tenant-a', SYSTEM_MODULE_ID, TENANT_TIME_ZONE_KEY),
		).toBe('Mars/Olympus');
		expect(tenantTimeZone(settings, 'tenant-a')).toBe(DEFAULT_TIME_ZONE);
	});

	it('takes the setting id, key and default from the shared contract', () => {
		expect([SYSTEM_MODULE_ID, TENANT_TIME_ZONE_KEY, DEFAULT_TIME_ZONE]).toEqual(
			[
				TENANT_TIME_ZONE_SETTING.moduleId,
				TENANT_TIME_ZONE_SETTING.key,
				TENANT_TIME_ZONE_SETTING.defaultValue,
			],
		);
		expect(SYSTEM_MODULE_SETTINGS.moduleId).toBe(
			TENANT_TIME_ZONE_SETTING.moduleId,
		);
		expect(Object.keys(SYSTEM_MODULE_SETTINGS.settings)).toContain(
			TENANT_TIME_ZONE_SETTING.key,
		);
	});

	it('refuses a stored value that does not match the declaration', () => {
		const settings = runtime();
		expect(() =>
			settings.set(
				'tenant-a',
				SYSTEM_MODULE_ID,
				TENANT_TIME_ZONE_KEY,
				'not a zone at all',
				'account-1',
			),
		).toThrow(/unsupported format/);
		expect(tenantTimeZone(settings, 'tenant-a')).toBe(DEFAULT_TIME_ZONE);
	});
});
