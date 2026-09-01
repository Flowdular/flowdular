import { describe, expect, it } from 'vitest';
import { moduleDefinition, SANDBOX_PERMISSIONS } from '../src/index.ts';
import { endpoints } from '../src/api/endpoints.ts';
import catalog from '../src/cli/commands.json' with { type: 'json' };
import { cliExtension } from '../src/cli/index.ts';

describe('sandbox.core', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('sandbox.core');
		expect(moduleDefinition.permissions).toContain(SANDBOX_PERMISSIONS.use);
	});

	it('registers every declared endpoint id once', () => {
		expect(new Set(endpoints).size).toBe(endpoints.length);
	});

	it('keeps the CLI implementation metadata-identical to its catalog', () => {
		expect(cliExtension.moduleId).toBe(catalog.moduleId);
		const declared = catalog.commands.map((command) => ({
			path: command.path,
			capability: command.capability,
		}));
		const implemented = cliExtension.commands.map((command) => ({
			path: [...command.path],
			capability: command.capability,
		}));
		expect(implemented).toEqual(declared);
	});
});
