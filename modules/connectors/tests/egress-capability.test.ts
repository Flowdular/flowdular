import { describe, expect, it } from 'vitest';
import type { ConnectorEgressLookup } from '../src/domain/egress.ts';
import { createConnectorEgressCapability } from '../src/services/egress.ts';
import { publicResolver } from './support/harness.ts';

const resolve = publicResolver({
	'pages.example.test': '93.184.216.34',
	'inside.example.test': '10.0.0.7',
});

function lookupOnce(
	lookup: ConnectorEgressLookup,
	hostname: string,
): Promise<string> {
	return new Promise((resolveAddress, reject) => {
		lookup(hostname, {}, (error, address) => {
			if (error) reject(error);
			else resolveAddress(String(address));
		});
	});
}

describe('connectors.egress.v1', () => {
	it('CONNECTORS-EGRESS-CAPABILITY answers the verified addresses and a lookup pinned to them', async () => {
		const egress = createConnectorEgressCapability(resolve);
		const answer = await egress.check('https://pages.example.test/about');
		expect(answer).toMatchObject({
			ok: true,
			url: 'https://pages.example.test/about',
			addresses: ['93.184.216.34'],
		});
		if (!answer.ok) throw new Error('expected an accepted URL');
		expect(await lookupOnce(answer.lookup, 'pages.example.test')).toBe(
			'93.184.216.34',
		);
		await expect(
			lookupOnce(answer.lookup, 'other.example.test'),
		).rejects.toThrow(/No verified address/);
	});

	it('CONNECTORS-EGRESS-CAPABILITY refuses http, address literals, local names, other ports and private resolution', async () => {
		const egress = createConnectorEgressCapability(resolve);
		const refusals = await Promise.all(
			[
				'http://pages.example.test/',
				'https://127.0.0.1/',
				'https://[::1]/',
				'https://localhost/',
				'https://user:secret@pages.example.test/',
				'https://pages.example.test:8443/',
				'https://inside.example.test/',
				'https://missing.example.test/',
				'not a url',
			].map((url) => egress.check(url)),
		);
		expect(refusals).toEqual([
			{ ok: false, reason: 'CONNECTOR_URL_BLOCKED' },
			{ ok: false, reason: 'CONNECTOR_URL_BLOCKED' },
			{ ok: false, reason: 'CONNECTOR_URL_BLOCKED' },
			{ ok: false, reason: 'CONNECTOR_URL_BLOCKED' },
			{ ok: false, reason: 'CONNECTOR_URL_BLOCKED' },
			{ ok: false, reason: 'CONNECTOR_PORT_REFUSED' },
			{ ok: false, reason: 'CONNECTOR_HOST_RESOLVES_PRIVATE' },
			{ ok: false, reason: 'CONNECTOR_HOST_UNRESOLVED' },
			{ ok: false, reason: 'CONNECTOR_URL_INVALID' },
		]);
	});
});
