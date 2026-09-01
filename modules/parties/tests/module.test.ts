import { describe, expect, it } from 'vitest';
import { moduleDefinition } from '../src/index.ts';
import { PartiesService } from '../src/services/parties-service.ts';
import { SqlitePartyRepository } from '../src/services/sqlite-repository.ts';

describe('parties.core', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('parties.core');
	});

	it('isolates party lists by trusted tenant id', () => {
		const service = new PartiesService(new SqlitePartyRepository(':memory:'));
		service.create('tenant-a', { name: 'Acme', kind: 'customer' });
		service.create('tenant-b', { name: 'Beta', kind: 'supplier' });

		expect(service.list('tenant-a').map((party) => party.name)).toEqual([
			'Acme',
		]);
		expect(service.list('tenant-b').map((party) => party.name)).toEqual([
			'Beta',
		]);
	});
});
