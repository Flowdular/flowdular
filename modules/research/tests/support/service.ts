import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectorAdapter } from '../../src/adapters/connector.ts';
import { createModelNativeAdapter } from '../../src/adapters/model-native.ts';
import { createRecordedAdapter } from '../../src/adapters/recorded.ts';
import type { ResearchSettings } from '../../src/domain/types.ts';
import type {
	ConnectorCalls,
	ConnectorEgress,
	EgressLookup,
	MeterRegistry,
} from '../../src/services/capabilities.ts';
import type {
	PageRequest,
	PageResponse,
	PageTransport,
} from '../../src/services/page-transport.ts';
import type { ResearchRepository } from '../../src/services/repository.ts';
import { ResearchService } from '../../src/services/research-service.ts';

export const PUBLIC_ADDRESS = '93.184.216.34';

export function testSettings(
	overrides: Partial<ResearchSettings> = {},
): ResearchSettings {
	return {
		adapter: 'recorded',
		connectorInstanceId: '',
		recordedFixturesPath: '',
		allowDomains: [],
		denyDomains: [],
		monthlyQueryBudget: 500,
		storeFullText: false,
		fetchMaxBytes: 2_000_000,
		fetchTimeoutMs: 20_000,
		allowAgents: false,
		...overrides,
	};
}

/** A lookup that answers one address for one host name, as a pinned policy does. */
export function pinned(hostname: string, address: string): EgressLookup {
	return (asked, options, callback) => {
		if (asked !== hostname) {
			callback(new Error(`No verified address is pinned for ${asked}.`), '', 0);
			return;
		}
		if (options.all === true) callback(null, [{ address, family: 4 }]);
		else callback(null, address, 4);
	};
}

export interface FakeEgress extends ConnectorEgress {
	readonly checked: string[];
}

/** Accepts every https URL except the hosts named, which it refuses with the reason given. */
export function fakeEgress(
	refused: Readonly<Record<string, string>> = {},
): FakeEgress {
	const checked: string[] = [];
	return {
		checked,
		async check(value) {
			checked.push(value);
			const url = new URL(value);
			const reason = refused[url.hostname];
			if (reason) return { ok: false, reason };
			if (url.protocol !== 'https:') {
				return { ok: false, reason: 'CONNECTOR_URL_BLOCKED' };
			}
			return {
				ok: true,
				url: url.toString(),
				addresses: [PUBLIC_ADDRESS],
				lookup: pinned(url.hostname, PUBLIC_ADDRESS),
			};
		},
	};
}

export type FakeReply =
	| (Partial<Omit<PageResponse, 'body'>> & { readonly body?: string | Buffer })
	| ((request: PageRequest) => Promise<PageResponse>);

export interface FakeTransport {
	readonly transport: PageTransport;
	readonly requests: string[];
}

/** Answers by exact URL; an unmapped robots.txt is a 404 and any other unmapped URL a failure. */
export function fakeTransport(
	replies: Readonly<Record<string, FakeReply>>,
): FakeTransport {
	const requests: string[] = [];
	return {
		requests,
		transport: async (request) => {
			const key = request.url.toString();
			requests.push(key);
			const reply =
				replies[key] ??
				(request.url.pathname === '/robots.txt' ? { status: 404 } : undefined);
			if (reply === undefined) throw new Error(`No reply for ${key}`);
			if (typeof reply === 'function') return reply(request);
			const body = Buffer.isBuffer(reply.body)
				? reply.body
				: Buffer.from(reply.body ?? '', 'utf8');
			const exceeded = body.byteLength > request.maxBytes;
			return {
				status: reply.status ?? 200,
				contentType: reply.contentType ?? 'text/html; charset=utf-8',
				location: reply.location ?? null,
				body: exceeded ? body.subarray(0, request.maxBytes) : body,
				exceeded: reply.exceeded ?? exceeded,
			};
		},
	};
}

export interface FakeMeters extends MeterRegistry {
	readonly recorded: string[];
	refuse: boolean;
}

export function fakeMeters(): FakeMeters {
	const meters: FakeMeters = {
		recorded: [],
		refuse: false,
		declare: () => undefined,
		record: async (input) => {
			meters.recorded.push(`${input.meter}:${input.sourceRef ?? ''}`);
			return { recorded: true, day: '2026-09-16' };
		},
		check: async () => ({
			verdict: meters.refuse ? 'refused' : 'allowed',
			used: 0,
			limit: null,
		}),
	};
	return meters;
}

export interface ServiceSetup {
	readonly repository: ResearchRepository;
	readonly settings?: ResearchSettings | (() => ResearchSettings);
	readonly calls?: ConnectorCalls;
	readonly egress?: ConnectorEgress;
	readonly meters?: MeterRegistry;
	readonly transport?: PageTransport;
	readonly workspaceRoot?: string;
	readonly now?: () => number;
}

export function researchService(setup: ServiceSetup): ResearchService {
	const settings = setup.settings ?? testSettings();
	return new ResearchService({
		repository: setup.repository,
		settings: async () =>
			typeof settings === 'function' ? settings() : settings,
		adapters: {
			modelNative: createModelNativeAdapter(setup.repository),
			connector: createConnectorAdapter(() => setup.calls),
			recorded: createRecordedAdapter(setup.workspaceRoot ?? tmpdir()),
		},
		egress: () => setup.egress,
		meters: () => setup.meters,
		transport:
			setup.transport ??
			(async () => {
				throw new Error('The network is not reachable in this case.');
			}),
		...(setup.now ? { now: setup.now } : {}),
	});
}

export interface Fixtures {
	readonly directory: string;
	readonly path: string;
	dispose(): Promise<void>;
}

export async function writeFixtures(
	content: unknown,
	name = 'research-fixtures.json',
): Promise<Fixtures> {
	const directory = await mkdtemp(join(tmpdir(), 'research-fixtures-'));
	const path = join(directory, name);
	await writeFile(path, JSON.stringify(content));
	return {
		directory,
		path,
		dispose: () => rm(directory, { recursive: true, force: true }),
	};
}
