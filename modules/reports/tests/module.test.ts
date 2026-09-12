import { describe, expect, it } from 'vitest';
import { moduleDefinition, REPORTS_PERMISSIONS } from '../src/index.ts';
import { REPORTS_PROVIDERS_CAPABILITY } from '../src/domain/providers.ts';
import manifest from '../module.json' with { type: 'json' };

describe('reports.core', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('reports.core');
		expect(moduleDefinition.permissions).toEqual(['reports.workspace.read']);
	});

	/* The identifier is the contract: a provider module hard-codes nothing and
	   resolves this exact string, so the manifest and the constant must agree. */
	it('provides the capability the manifest declares', () => {
		expect(REPORTS_PROVIDERS_CAPABILITY).toBe('reports.v1');
		expect(manifest.provides).toContain(REPORTS_PROVIDERS_CAPABILITY);
	});

	it('names the permission the endpoint and the client both gate on', () => {
		expect(REPORTS_PERMISSIONS.read).toBe('reports.workspace.read');
	});
});
