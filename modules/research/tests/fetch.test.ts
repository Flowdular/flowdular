import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DocumentsText } from '../src/services/capabilities.ts';
import {
	openResearchTestDatabase,
	type ResearchTestDatabase,
} from './support/database.ts';
import {
	fakeEgress,
	fakeTransport,
	researchService,
	testSettings,
	writeFixtures,
	type Fixtures,
} from './support/service.ts';

const TENANT = 'tenant-fetch';
const PAGE = (body: string) =>
	`<html><head><title>Page</title></head><body><article><p>${body}</p></article></body></html>`;

let shared: ResearchTestDatabase;
let fixtures: Fixtures;

beforeAll(async () => {
	shared = await openResearchTestDatabase();
	fixtures = await writeFixtures({
		queries: {},
		pages: {
			'https://registry.example.org/acme': {
				title: 'Acme in the registry',
				text: 'Acme Insurance ' + 'was registered in 1999. '.repeat(400),
			},
		},
	});
});

afterEach(async () => {
	await shared.reset();
});

afterAll(async () => {
	await fixtures?.dispose();
	await shared?.dispose();
});

describe('research fetch', () => {
	it('RESEARCH-FETCH-RECORDED reads a recorded page as evidence and refuses an unrecorded URL without the network', async () => {
		const network = fakeTransport({});
		const egress = fakeEgress();
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({ recordedFixturesPath: fixtures.path }),
			egress,
			transport: network.transport,
		});

		const page = await service.fetch(
			{
				tenantId: TENANT,
				url: 'https://registry.example.org/acme',
				caller: 'member',
			},
			'account-member',
		);

		expect(page.title).toBe('Acme in the registry');
		expect(page.contentSha256).toMatch(/^[0-9a-f]{64}$/);
		const stored = await shared.repository.findEvidence(
			TENANT,
			page.evidenceId,
		);
		expect(stored).toMatchObject({
			url: 'https://registry.example.org/acme',
			contentSha256: page.contentSha256,
			createdBy: 'account-member',
			fullText: null,
		});
		expect(Buffer.byteLength(stored!.excerpt, 'utf8')).toBeLessThanOrEqual(
			4_096,
		);
		expect(page.text.startsWith(stored!.excerpt)).toBe(true);

		await expect(
			service.fetch({
				tenantId: TENANT,
				url: 'https://registry.example.org/other',
				caller: 'member',
			}),
		).rejects.toMatchObject({
			code: 'RESEARCH_PAGE_NOT_RECORDED',
			status: 404,
		});
		expect(network.requests).toEqual([]);
		expect(egress.checked).toEqual([]);
	});

	it('RESEARCH-DOMAINS reads allowed hosts and refuses denied ones before the egress policy is asked', async () => {
		const network = fakeTransport({
			'https://example.org/a': { body: PAGE('Root') },
			'https://docs.example.org/b': { body: PAGE('Docs') },
		});
		const egress = fakeEgress();
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({
				adapter: 'model-native',
				allowDomains: ['example.org'],
				denyDomains: ['blocked.example.org'],
			}),
			egress,
			transport: network.transport,
		});
		const fetch = (url: string) =>
			service.fetch({ tenantId: TENANT, url, caller: 'member' });

		expect((await fetch('https://example.org/a')).text).toBe('Root');
		expect((await fetch('https://docs.example.org/b')).text).toBe('Docs');
		const checkedBefore = egress.checked.length;
		for (const url of [
			'https://blocked.example.org/c',
			'https://other.example/d',
		]) {
			await expect(fetch(url)).rejects.toMatchObject({
				code: 'RESEARCH_DOMAIN_DENIED',
				status: 403,
			});
		}
		expect(egress.checked).toHaveLength(checkedBefore);
		await expect(fetch('http://example.org/a')).rejects.toMatchObject({
			code: 'RESEARCH_URL_INVALID',
		});
	});

	it('RESEARCH-ROBOTS honours robots.txt, refuses an unreadable one and reads it once per host within the hour', async () => {
		const network = fakeTransport({
			'https://rules.example/robots.txt': {
				contentType: 'text/plain',
				body: [
					'User-agent: OtherBot',
					'Disallow: /',
					'',
					'User-agent: *',
					'Disallow: /private/',
					'Allow: /private/public$',
				].join('\n'),
			},
			'https://rules.example/open': { body: PAGE('Open') },
			'https://rules.example/private/public': { body: PAGE('Public') },
			'https://broken.example/robots.txt': { status: 503 },
			'https://broken.example/page': { body: PAGE('Never') },
		});
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({ adapter: 'model-native' }),
			egress: fakeEgress(),
			transport: network.transport,
		});
		const fetch = (url: string) =>
			service.fetch({ tenantId: TENANT, url, caller: 'member' });

		await expect(
			fetch('https://rules.example/private/data'),
		).rejects.toMatchObject({
			code: 'RESEARCH_ROBOTS_DISALLOWED',
			status: 403,
		});
		expect((await fetch('https://rules.example/open')).text).toBe('Open');
		expect((await fetch('https://rules.example/private/public')).text).toBe(
			'Public',
		);
		await expect(fetch('https://broken.example/page')).rejects.toMatchObject({
			code: 'RESEARCH_ROBOTS_UNAVAILABLE',
		});
		await expect(fetch('https://broken.example/page')).rejects.toMatchObject({
			code: 'RESEARCH_ROBOTS_UNAVAILABLE',
		});

		expect(
			network.requests.filter(
				(url) => url === 'https://rules.example/robots.txt',
			),
		).toHaveLength(1);
		expect(
			network.requests.filter(
				(url) => url === 'https://broken.example/robots.txt',
			),
		).toHaveLength(2);
		expect(network.requests).not.toContain('https://broken.example/page');
		expect(network.requests).not.toContain(
			'https://rules.example/private/data',
		);
	});

	it('RESEARCH-FETCH-LIMITS refuses oversize, slow, twice redirected, PDF, failing and egress-refused pages without evidence', async () => {
		const network = fakeTransport({
			'https://limits.example/large': { body: 'x'.repeat(4_096) },
			'https://limits.example/slow': (request) =>
				new Promise((_, reject) => {
					request.signal.addEventListener('abort', () =>
						reject(new Error('aborted')),
					);
				}),
			'https://limits.example/hop-1': { status: 302, location: '/hop-2' },
			'https://limits.example/hop-2': {
				status: 301,
				location: 'https://limits.example/hop-3',
			},
			'https://limits.example/once': { status: 302, location: '/landing' },
			'https://limits.example/landing': { body: PAGE('Landed') },
			'https://limits.example/report.pdf': {
				contentType: 'application/pdf',
				body: '%PDF-1.7',
			},
			'https://limits.example/binary': {
				contentType: 'application/octet-stream',
				body: 'MZ',
			},
			'https://limits.example/error': { status: 500, body: 'down' },
		});
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({
				adapter: 'model-native',
				fetchMaxBytes: 1_024,
				fetchTimeoutMs: 50,
			}),
			egress: fakeEgress({
				'refused.example': 'CONNECTOR_HOST_RESOLVES_PRIVATE',
			}),
			transport: network.transport,
		});
		const fetch = (url: string) =>
			service.fetch({ tenantId: TENANT, url, caller: 'member' });

		const cases: readonly (readonly [string, string, number])[] = [
			['https://limits.example/large', 'RESEARCH_FETCH_TOO_LARGE', 413],
			['https://limits.example/slow', 'RESEARCH_FETCH_TIMEOUT', 504],
			['https://limits.example/hop-1', 'RESEARCH_REDIRECT_REFUSED', 502],
			[
				'https://limits.example/report.pdf',
				'RESEARCH_CONTENT_UNSUPPORTED',
				415,
			],
			['https://limits.example/binary', 'RESEARCH_CONTENT_UNSUPPORTED', 415],
			['https://limits.example/error', 'RESEARCH_FETCH_FAILED', 502],
			['https://refused.example/page', 'RESEARCH_EGRESS_REFUSED', 403],
		];
		for (const [url, code, status] of cases) {
			await expect(fetch(url)).rejects.toMatchObject({ code, status });
		}
		expect(await shared.repository.listEvidence(TENANT, 10, null)).toEqual([]);

		const landed = await fetch('https://limits.example/once');
		expect(landed.text).toBe('Landed');
		expect(network.requests).not.toContain('https://limits.example/hop-3');
		await fetch('https://limits.example/once');
		expect(
			network.requests.filter(
				(url) => url === 'https://limits.example/landing',
			),
		).toHaveLength(2);

		await expect(
			fetch(
				'https://limits.example/' + String.fromCodePoint(0xe9).repeat(1_000),
			),
		).rejects.toMatchObject({ code: 'RESEARCH_URL_INVALID' });
	});

	it('RESEARCH-FETCH-LIMITS applies the domain rules, robots.txt and the egress policy to a redirect target', async () => {
		const network = fakeTransport({
			'https://start.example/denied': {
				status: 302,
				location: 'https://denied.example/page',
			},
			'https://start.example/robots': {
				status: 302,
				location: 'https://rules.example/private/page',
			},
			'https://start.example/refused': {
				status: 302,
				location: 'https://refused.example/page',
			},
			'https://rules.example/robots.txt': {
				contentType: 'text/plain',
				body: 'User-agent: *\nDisallow: /private/',
			},
		});
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({
				adapter: 'model-native',
				denyDomains: ['denied.example'],
			}),
			egress: fakeEgress({
				'refused.example': 'CONNECTOR_HOST_RESOLVES_PRIVATE',
			}),
			transport: network.transport,
		});
		const fetch = (url: string) =>
			service.fetch({ tenantId: TENANT, url, caller: 'member' });

		await expect(fetch('https://start.example/denied')).rejects.toMatchObject({
			code: 'RESEARCH_DOMAIN_DENIED',
		});
		await expect(fetch('https://start.example/robots')).rejects.toMatchObject({
			code: 'RESEARCH_ROBOTS_DISALLOWED',
		});
		await expect(fetch('https://start.example/refused')).rejects.toMatchObject({
			code: 'RESEARCH_EGRESS_REFUSED',
		});
		expect(network.requests).not.toContain('https://denied.example/page');
		expect(network.requests).not.toContain(
			'https://rules.example/private/page',
		);
		expect(await shared.repository.listEvidence(TENANT, 10, null)).toEqual([]);
	});

	it('RESEARCH-FETCH-LIMITS answers RESEARCH_FETCH_TIMEOUT when the host does not resolve in time', async () => {
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({ adapter: 'model-native', fetchTimeoutMs: 50 }),
			egress: { check: () => new Promise(() => undefined) },
			transport: fakeTransport({}).transport,
		});
		await expect(
			service.fetch({
				tenantId: TENANT,
				url: 'https://slow-dns.example/',
				caller: 'member',
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_FETCH_TIMEOUT', status: 504 });
	});

	it('RESEARCH-FETCH-LIMITS answers RESEARCH_EGRESS_UNAVAILABLE without connectors.core', async () => {
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({ adapter: 'model-native' }),
		});
		await expect(
			service.fetch({
				tenantId: TENANT,
				url: 'https://example.org/',
				caller: 'member',
			}),
		).rejects.toMatchObject({
			code: 'RESEARCH_EGRESS_UNAVAILABLE',
			status: 409,
		});
	});

	it('RESEARCH-RUN-LIMIT refuses the 65th fetch of a run before the network and leaves another run alone', async () => {
		const network = fakeTransport({});
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({ recordedFixturesPath: fixtures.path }),
			egress: fakeEgress(),
			transport: network.transport,
		});
		const fetch = (runId: string) =>
			service.fetch({
				tenantId: TENANT,
				url: 'https://registry.example.org/acme',
				caller: 'agent',
				callerRef: runId,
			});

		for (let index = 0; index < 64; index += 1) await fetch('run-busy');
		await expect(fetch('run-busy')).rejects.toMatchObject({
			code: 'RESEARCH_RUN_LIMIT',
			status: 429,
		});
		await expect(fetch('run-fresh')).resolves.toMatchObject({
			title: 'Acme in the registry',
		});
		expect(network.requests).toEqual([]);
		const evidence = await shared.repository.listEvidence(TENANT, 100, null);
		expect(evidence).toHaveLength(65);
	});

	it('RESEARCH-FETCH-PDF reads a PDF through documents.text.v1 and keeps the old refusal without it', async () => {
		const network = fakeTransport({
			'https://reports.example/annual.pdf': {
				contentType: 'application/pdf',
				body: Buffer.from('%PDF-1.7 with a text layer', 'latin1'),
			},
			'https://reports.example/scan': {
				contentType: 'application/octet-stream',
				body: Buffer.from('%PDF-1.7 scanned', 'latin1'),
			},
			'https://reports.example/other.pdf': {
				contentType: 'application/pdf',
				body: Buffer.from('%PDF-1.7 with a text layer', 'latin1'),
			},
		});
		const handed: {
			readonly contentType: string;
			readonly bytes: string;
			readonly signal: boolean;
		}[] = [];
		const documentsText: DocumentsText = {
			async extractBytes(input) {
				const bytes = Buffer.from(input.bytes).toString('latin1');
				handed.push({
					contentType: input.contentType,
					bytes,
					signal: input.signal instanceof AbortSignal,
				});
				return bytes.includes('scanned')
					? {
							status: 'unscanned',
							reason: 'DOCUMENT_OCR_UNCONFIGURED',
							text: '',
						}
					: {
							status: 'ok',
							reason: null,
							text: 'Annual report\fSecond page',
						};
			},
		};
		const settings = testSettings({ adapter: 'model-native' });
		const composed = researchService({
			repository: shared.repository,
			settings,
			egress: fakeEgress(),
			transport: network.transport,
			documentsText,
		});

		const page = await composed.fetch({
			tenantId: TENANT,
			url: 'https://reports.example/annual.pdf',
			caller: 'member',
		});
		expect(page).toMatchObject({
			title: 'reports.example/annual.pdf',
			text: 'Annual report\n\nSecond page',
		});
		expect(handed).toEqual([
			{
				contentType: 'application/pdf',
				bytes: '%PDF-1.7 with a text layer',
				signal: true,
			},
		]);
		await expect(
			composed.fetch({
				tenantId: TENANT,
				url: 'https://reports.example/scan',
				caller: 'member',
			}),
		).rejects.toMatchObject({
			code: 'RESEARCH_CONTENT_UNSUPPORTED',
			status: 415,
		});
		expect(
			(await shared.repository.listEvidence(TENANT, 10, null)).map(
				(entry) => entry.url,
			),
		).toEqual(['https://reports.example/annual.pdf']);

		const alone = researchService({
			repository: shared.repository,
			settings,
			egress: fakeEgress(),
			transport: network.transport,
		});
		await expect(
			alone.fetch({
				tenantId: TENANT,
				url: 'https://reports.example/other.pdf',
				caller: 'member',
			}),
		).rejects.toMatchObject({
			code: 'RESEARCH_CONTENT_UNSUPPORTED',
			status: 415,
		});
		expect(handed).toHaveLength(2);

		const stalled = researchService({
			repository: shared.repository,
			settings: testSettings({ adapter: 'model-native', fetchTimeoutMs: 50 }),
			egress: fakeEgress(),
			transport: network.transport,
			documentsText: {
				extractBytes: (input) =>
					new Promise((_, reject) => {
						input.signal?.addEventListener('abort', () =>
							reject(new Error('aborted')),
						);
					}),
			},
		});
		await expect(
			stalled.fetch({
				tenantId: TENANT,
				url: 'https://reports.example/other.pdf',
				caller: 'member',
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_FETCH_TIMEOUT', status: 504 });
	});
});
