import { describe, expect, it } from 'vitest';
import { TENANT_TIME_ZONE_SETTING } from '@flowdular/contracts';
import {
	createModuleSettingsRuntime,
	defineModuleSettings,
	type ModuleSettingsStore,
	type ModuleSettingValue,
} from '@flowdular/kernel';
import {
	DEFAULT_TIME_ZONE,
	TENANT_TIME_ZONE_KEY,
	TENANT_TIME_ZONE_MODULE_ID,
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

/* The declaration the owning module composes, restated here because this module
   reads the setting through the runtime and never imports system.core. */
const OWNER_SETTINGS = defineModuleSettings({
	moduleId: TENANT_TIME_ZONE_MODULE_ID,
	settings: {
		[TENANT_TIME_ZONE_KEY]: {
			type: 'string',
			defaultValue: DEFAULT_TIME_ZONE,
			visibility: 'shared',
			client: false,
			scope: 'tenant',
			min: 1,
			max: 64,
		},
	},
});

function runtime() {
	const settings = createModuleSettingsRuntime(memoryStore());
	settings.declare(OWNER_SETTINGS);
	return settings;
}

const ZONES = Intl.supportedValuesOf('timeZone');

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
	it('takes the setting id, key and default from the shared contract', () => {
		expect([
			TENANT_TIME_ZONE_MODULE_ID,
			TENANT_TIME_ZONE_KEY,
			DEFAULT_TIME_ZONE,
		]).toEqual([
			TENANT_TIME_ZONE_SETTING.moduleId,
			TENANT_TIME_ZONE_SETTING.key,
			TENANT_TIME_ZONE_SETTING.defaultValue,
		]);
	});

	it('reads the zone the workspace stored', () => {
		const settings = runtime();
		settings.set(
			'tenant-a',
			TENANT_TIME_ZONE_MODULE_ID,
			TENANT_TIME_ZONE_KEY,
			'Europe/Warsaw',
			'account-1',
		);
		expect(tenantTimeZone(settings, 'tenant-a')).toBe('Europe/Warsaw');
	});

	/* Both fallbacks the scheduler depends on: the zone has to answer even where
	   the owning module is absent, and where the stored name means nothing here. */
	it('falls back to UTC without the owning module and for an unknown zone', () => {
		const absent = createModuleSettingsRuntime(memoryStore());
		expect(tenantTimeZone(absent, 'tenant-a')).toBe(DEFAULT_TIME_ZONE);

		const settings = runtime();
		settings.set(
			'tenant-a',
			TENANT_TIME_ZONE_MODULE_ID,
			TENANT_TIME_ZONE_KEY,
			'Mars/Olympus',
			'account-1',
		);
		expect(tenantTimeZone(settings, 'tenant-a')).toBe(DEFAULT_TIME_ZONE);
	});

	/* A workspace can store any spelling of its zone. They all name one zone, so
	   they cost one probe and one entry. */
	it('accepts every spelling of a zone from one cached entry', () => {
		const settings = runtime();
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
				settings.set(
					'tenant-a',
					TENANT_TIME_ZONE_MODULE_ID,
					TENANT_TIME_ZONE_KEY,
					spelling,
					'account-1',
				);
				expect(tenantTimeZone(settings, 'tenant-a'), spelling).toBe(spelling);
			}
		});
		expect(probes).toBeLessThanOrEqual(1);
	});

	/* The accepted names are a cache, not a directory of every zone the process
	   was ever asked about. */
	it('stops holding accepted zones once the cache is full', () => {
		const settings = runtime();
		expect(ZONES.length).toBeGreaterThan(40);
		const read = (zone: string) => {
			settings.set(
				'tenant-a',
				TENANT_TIME_ZONE_MODULE_ID,
				TENANT_TIME_ZONE_KEY,
				zone,
				'account-1',
			);
			return tenantTimeZone(settings, 'tenant-a');
		};
		const first = ZONES[0]!;
		for (const zone of ZONES.slice(0, 40)) expect(read(zone), zone).toBe(zone);
		expect(probeCount(() => read(first))).toBe(1);
	});
});
