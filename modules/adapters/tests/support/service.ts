import type { AuthPrincipal } from '@flowdular/module-auth';
import type { JobRunner } from '@flowdular/server';
import type {
	AdapterRecordedFixture,
	AdapterRegistration,
} from '../../src/domain/registry.ts';
import { AdaptersService } from '../../src/services/adapters-service.ts';
import {
	createAdapterCatalogue,
	type AdapterCatalogue,
} from '../../src/services/registry.ts';
import {
	createAdapterRunRunner,
	createAdapterScheduleRunner,
} from '../../src/services/runners.ts';
import type { AdaptersTestDatabase } from './database.ts';
import {
	createFakeCalls,
	createFakeList,
	createFakeMeters,
	createFakeWriter,
	OWNER,
	principal,
	TENANT,
	type FakeCalls,
	type FakeList,
	type FakeMeters,
	type FakeWriter,
} from './fakes.ts';

export const SOURCE_ID = 'vendors.core.erp-vendors';
export const SINK_ID = 'vendors.core.crm-push';

/** Two cursor pages of three vendors; the second carries a country the mapping refuses. */
export const SOURCE_FIXTURE: AdapterRecordedFixture = {
	adapter: SOURCE_ID,
	operation: 'get',
	calls: [
		{
			input: { path: '/vendors', query: { limit: 2 } },
			body: {
				data: [
					{ id: 'V1', title: 'Acme', country: 'pl' },
					{ id: 'V2', title: 'Globex', country: { code: 'us' } },
				],
				meta: { next: 'c2' },
			},
		},
		{
			input: { path: '/vendors', query: { limit: 2, cursor: 'c2' } },
			body: {
				data: [{ id: 'V3', title: 'Initech', country: 'de' }],
				meta: { next: null },
			},
		},
	],
};

export function sourceRegistration(
	overrides: Partial<AdapterRegistration> = {},
): AdapterRegistration {
	return {
		id: SOURCE_ID,
		direction: 'source',
		label: 'ERP vendors',
		connector: 'http-json',
		operation: 'get',
		port: 'vendors.core.records',
		schedule: null,
		mapping: [
			{ from: 'id', to: 'code', transform: 'rename' },
			{ from: 'title', to: 'name', transform: 'rename' },
			{ from: 'country', to: 'country', transform: 'format', value: 'upper' },
		],
		input: { path: '/vendors', query: { limit: 2 } },
		items: 'data',
		paging: { kind: 'cursor', param: 'query.cursor', next: 'meta.next' },
		recorded: SOURCE_FIXTURE,
		...overrides,
	};
}

export function sinkRegistration(
	overrides: Partial<AdapterRegistration> = {},
): AdapterRegistration {
	return {
		id: SINK_ID,
		direction: 'sink',
		label: 'CRM push',
		connector: 'http-json',
		operation: 'post',
		port: 'vendors.core.records',
		schedule: null,
		mapping: [
			{ from: 'code', to: 'externalId', transform: 'rename' },
			{ from: 'name', to: 'profile.name', transform: 'rename' },
		],
		input: { path: '/import' },
		items: 'body.records',
		batchSize: 2,
		...overrides,
	};
}

export interface ServiceHarness {
	readonly catalogue: AdapterCatalogue;
	readonly writer: FakeWriter;
	readonly calls: FakeCalls;
	readonly list: FakeList;
	readonly meters: FakeMeters;
	readonly service: AdaptersService;
	readonly principals: Map<string, AuthPrincipal>;
	readonly sleeps: number[];
	clock: number;
	runs(options?: {
		readonly claimTimeoutMs?: number;
		readonly heartbeatEveryMs?: number;
	}): JobRunner;
	schedule(): JobRunner;
}

export interface ServiceHarnessOptions {
	readonly recordedAllowed?: boolean;
	readonly timeZone?: string;
	readonly register?: (catalogue: AdapterCatalogue) => void;
	readonly batchSize?: number;
}

/**
 * The service over the real schema with a fake of every capability it
 * consumes, so what is under test is this module between them.
 */
export function serviceHarness(
	database: AdaptersTestDatabase,
	options: ServiceHarnessOptions = {},
): ServiceHarness {
	const catalogue = createAdapterCatalogue();
	if (options.register) options.register(catalogue);
	else {
		catalogue.sources.register('vendors.core', [sourceRegistration()]);
		catalogue.sinks.register('vendors.core', [sinkRegistration()]);
	}
	catalogue.seal();
	const writer = createFakeWriter(options.batchSize);
	const calls = createFakeCalls();
	const list = createFakeList();
	const meters = createFakeMeters();
	const principals = new Map<string, AuthPrincipal>([[OWNER, principal()]]);
	const sleeps: number[] = [];
	let ids = 0;
	const harness: ServiceHarness = {
		catalogue,
		writer,
		calls,
		list,
		meters,
		principals,
		sleeps,
		clock: Date.UTC(2026, 8, 16, 9, 0, 0),
		service: undefined as never,
		runs: (runner = {}) =>
			createAdapterRunRunner({
				repository: async () => database.repository,
				service: async () => harness.service,
				now: () => harness.clock,
				pollIntervalMs: 60_000,
				claimTimeoutMs: runner.claimTimeoutMs ?? 60_000,
				heartbeatEveryMs: runner.heartbeatEveryMs ?? 30_000,
				onEvent: () => undefined,
			}),
		schedule: () =>
			createAdapterScheduleRunner({
				repository: async () => database.repository,
				service: async () => harness.service,
				now: () => harness.clock,
				pollIntervalMs: 60_000,
				onEvent: () => undefined,
			}),
	};
	(harness as { service: AdaptersService }).service = new AdaptersService({
		repository: database.repository,
		catalogue,
		calls: () => calls.calls,
		writer: () => writer.writer,
		lists: () => list.lists,
		meters: () => meters.meters,
		principal: async (tenantId, accountId) => {
			const found = principals.get(accountId);
			return found && found.tenantId === tenantId ? found : null;
		},
		timeZone: async () => options.timeZone ?? 'UTC',
		recordedAllowed: options.recordedAllowed ?? true,
		now: () => harness.clock,
		newId: () => `id-${String((ids += 1)).padStart(6, '0')}`,
		random: () => 0.5,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	return harness;
}

export { TENANT };
