import { describe, expect, it } from 'vitest';
import type { ModuleCliCatalog } from '@flowdular/cli-protocol';
import type { ModuleManifest } from '@flowdular/contracts';
import { validateCliCatalog } from '../src/extensions.ts';

const manifest: ModuleManifest = {
	schemaVersion: 1,
	id: 'customer.core',
	package: '@flowdular/module-customer',
	version: '0.1.0',
	profile: 'full',
	capabilities: ['cli'],
	dependencies: [],
	tenancy: 'required',
	locales: ['en'],
	stability: 'experimental',
	cli: { catalog: 'src/cli/commands.json', entry: 'src/cli/index.ts' },
};

function catalog(path: readonly [string, ...string[]]): ModuleCliCatalog {
	return {
		protocolVersion: 1,
		moduleId: 'customer.core',
		commands: [
			{
				path,
				capability: {
					id: 'customer.export',
					version: 1,
					summary: 'Export customers.',
					risk: 'workspace-write',
					requiresApprovedSpec: true,
					supportsDryRun: true,
				},
			},
		],
	};
}

describe('module CLI extension contract', () => {
	it('accepts a namespaced customer export command', () => {
		expect(() =>
			validateCliCatalog(catalog(['customer', 'export']), manifest),
		).not.toThrow();
	});

	it('rejects an attempt to claim a core command', () => {
		expect(() =>
			validateCliCatalog(catalog(['module', 'export']), manifest),
		).toThrow('inside "customer"');
	});
});
