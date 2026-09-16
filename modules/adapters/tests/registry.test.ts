import { describe, expect, it } from 'vitest';
import type { AdapterRegistration } from '../src/domain/registry.ts';
import { createAdapterCatalogue } from '../src/services/registry.ts';
import {
	sinkRegistration,
	sourceRegistration,
	SOURCE_FIXTURE,
} from './support/service.ts';

function code(work: () => void): string {
	try {
		work();
	} catch (error) {
		return String((error as { code?: unknown }).code);
	}
	return 'ACCEPTED';
}

describe('ADAPTERS-REGISTRATION the adapter catalogue', () => {
	it('lists a source and a sink with the module that registered them', () => {
		const catalogue = createAdapterCatalogue();
		catalogue.sources.register('vendors.core', [sourceRegistration()]);
		catalogue.sinks.register('vendors.core', [sinkRegistration()]);
		expect(
			catalogue
				.list()
				.map((entry) => [
					entry.registration.id,
					entry.moduleId,
					entry.registration.direction,
				]),
		).toEqual([
			['vendors.core.crm-push', 'vendors.core', 'sink'],
			['vendors.core.erp-vendors', 'vendors.core', 'source'],
		]);
		expect(
			catalogue.find('vendors.core.erp-vendors')?.registration.recorded,
		).toEqual(SOURCE_FIXTURE);
		expect(catalogue.find('vendors.core.absent')).toBeNull();
	});

	it('refuses every registration that breaks a rule, and keeps nothing of a refused call', () => {
		const refused = (
			direction: 'sources' | 'sinks',
			moduleId: string,
			entry: AdapterRegistration,
		) => {
			const catalogue = createAdapterCatalogue();
			const answer = code(() =>
				catalogue[direction].register(moduleId, [entry]),
			);
			expect(catalogue.list()).toEqual([]);
			return answer;
		};
		const cases: readonly [string, string][] = [
			[
				'outside the namespace',
				refused('sources', 'crm.core', sourceRegistration()),
			],
			[
				'a sink through the sources capability',
				refused('sources', 'vendors.core', sinkRegistration()),
			],
			[
				'a sink of another module list',
				refused(
					'sinks',
					'vendors.core',
					sinkRegistration({ port: 'users.core.members' }),
				),
			],
			[
				'a malformed cron',
				refused(
					'sources',
					'vendors.core',
					sourceRegistration({ schedule: 'hourly' }),
				),
			],
			[
				'a fixture of another adapter',
				refused(
					'sources',
					'vendors.core',
					sourceRegistration({
						recorded: { ...SOURCE_FIXTURE, adapter: 'vendors.core.other' },
					}),
				),
			],
			[
				'a mapping without rules',
				refused('sources', 'vendors.core', sourceRegistration({ mapping: [] })),
			],
			[
				'a format nobody knows',
				refused(
					'sources',
					'vendors.core',
					sourceRegistration({
						mapping: [
							{ from: 'id', to: 'code', transform: 'format', value: 'roman' },
						],
					}),
				),
			],
			[
				'cursor paging without a next path',
				refused(
					'sources',
					'vendors.core',
					sourceRegistration({
						paging: { kind: 'cursor', param: 'query.cursor', next: '' },
					}),
				),
			],
			[
				'a sink without an items path',
				refused(
					'sinks',
					'vendors.core',
					sinkRegistration({ items: undefined }),
				),
			],
			[
				'a batch size past the bound',
				refused('sinks', 'vendors.core', sinkRegistration({ batchSize: 500 })),
			],
			[
				'a path through the prototype',
				refused(
					'sources',
					'vendors.core',
					sourceRegistration({ items: '__proto__.data' }),
				),
			],
		];
		for (const [label, answer] of cases) {
			expect([label, answer]).toEqual([label, 'ADAPTER_REGISTRATION_INVALID']);
		}

		const catalogue = createAdapterCatalogue();
		expect(
			code(() =>
				catalogue.sources.register('vendors.core', [
					sourceRegistration({ id: 'vendors.core.first' }),
					sourceRegistration({ id: 'vendors.core.first' }),
				]),
			),
		).toBe('ADAPTER_REGISTRATION_INVALID');
		expect(catalogue.list()).toEqual([]);
	});

	it('is sealed once adapters.core starts', () => {
		const catalogue = createAdapterCatalogue();
		catalogue.seal();
		expect(
			code(() =>
				catalogue.sources.register('vendors.core', [sourceRegistration()]),
			),
		).toBe('ADAPTER_REGISTRY_SEALED');
	});
});
