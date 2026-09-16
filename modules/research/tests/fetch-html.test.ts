import { createServer, type Server } from 'node:https';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { httpsPageTransport } from '../src/services/page-transport.ts';
import type { ConnectorEgress } from '../src/services/capabilities.ts';
import {
	openResearchTestDatabase,
	type ResearchTestDatabase,
} from './support/database.ts';
import { pinned, researchService, testSettings } from './support/service.ts';
import { TEST_CERTIFICATE, TEST_PRIVATE_KEY } from './support/tls.ts';

const TENANT = 'tenant-html';
/* The entities decode to these characters; they are spelled by code point. */
const EN_DASH = String.fromCodePoint(0x2013);
const EM_DASH = String.fromCodePoint(0x2014);
const HOST = 'pages.example.test';

const ARTICLE = `<!doctype html>
<html>
<head><title>Acme &amp; Sons &#8211; Profile</title><style>body{}</style></head>
<body>
<nav><a href="/">Home</a> Navigation links</nav>
<script>window.secret = "never read";</script>
<article>
<h1>Acme &amp; Sons</h1>
<p>Acme &amp; Sons writes marine policies since 1999 &mdash; and keeps a register of claims.</p>
<!-- an editorial comment -->
<p>${'The register lists every claim in the port of Gdansk. '.repeat(8)}</p>
</article>
<footer>Copyright footer</footer>
</body>
</html>`;

let shared: ResearchTestDatabase;
let server: Server;
let port = 0;
const requested: string[] = [];

beforeAll(async () => {
	shared = await openResearchTestDatabase();
	server = createServer(
		{ cert: TEST_CERTIFICATE, key: TEST_PRIVATE_KEY },
		(request, response) => {
			requested.push(`${request.headers.host} ${request.url}`);
			if (request.url === '/robots.txt') {
				response.writeHead(404).end();
				return;
			}
			response
				.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
				.end(ARTICLE);
		},
	);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	port = typeof address === 'object' && address ? address.port : 0;
});

afterEach(async () => {
	await shared.reset();
	requested.length = 0;
});

afterAll(async () => {
	server?.closeAllConnections?.();
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	await shared?.dispose();
});

/* The policy verified a public-looking name and pinned it to the loopback
   address this server listens on; the transport dials nothing else. */
const egress: ConnectorEgress = {
	async check(value) {
		const url = new URL(value);
		return {
			ok: true,
			url: url.toString(),
			addresses: ['127.0.0.1'],
			lookup: pinned(url.hostname, '127.0.0.1'),
		};
	},
};

describe('research fetch over TLS', () => {
	it('RESEARCH-FETCH-HTML reads the article as text, keeps the full text and serves a repeat from the cache', async () => {
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({ adapter: 'model-native', storeFullText: true }),
			egress,
			transport: httpsPageTransport({ port, ca: TEST_CERTIFICATE }),
		});
		const url = `https://${HOST}/acme`;

		const first = await service.fetch({
			tenantId: TENANT,
			url,
			caller: 'member',
		});

		expect(first.title).toBe(`Acme & Sons ${EN_DASH} Profile`);
		expect(first.text).toContain(
			'Acme & Sons writes marine policies since 1999',
		);
		expect(first.text).toContain(`${EM_DASH} and keeps a register of claims.`);
		expect(first.text).not.toContain('Navigation links');
		expect(first.text).not.toContain('never read');
		expect(first.text).not.toContain('editorial comment');
		expect(first.text).not.toContain('Copyright footer');
		expect(requested).toEqual([
			`${HOST}:${port} /robots.txt`,
			`${HOST}:${port} /acme`,
		]);
		const stored = await shared.repository.findEvidence(
			TENANT,
			first.evidenceId,
		);
		expect(stored?.fullText).toBe(first.text);

		const second = await service.fetch({
			tenantId: TENANT,
			url,
			caller: 'member',
		});
		expect(second.contentSha256).toBe(first.contentSha256);
		expect(second.evidenceId).not.toBe(first.evidenceId);
		expect(requested).toHaveLength(2);
	});

	it('RESEARCH-FETCH-HTML never dials a host the policy did not pin', async () => {
		const service = researchService({
			repository: shared.repository,
			settings: testSettings({ adapter: 'model-native' }),
			egress: {
				async check(value) {
					const url = new URL(value);
					return {
						ok: true,
						url: url.toString(),
						addresses: ['127.0.0.1'],
						lookup: pinned('another.example.test', '127.0.0.1'),
					};
				},
			},
			transport: httpsPageTransport({ port, ca: TEST_CERTIFICATE }),
		});
		await expect(
			service.fetch({
				tenantId: TENANT,
				url: `https://${HOST}/acme`,
				caller: 'member',
			}),
		).rejects.toMatchObject({ code: 'RESEARCH_ROBOTS_UNAVAILABLE' });
		expect(requested).toEqual([]);
	});
});
