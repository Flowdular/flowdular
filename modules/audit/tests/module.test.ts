import { describe, expect, it } from 'vitest';
import { moduleDefinition } from '../src/index.ts';
import { AUDIT_PERMISSIONS } from '../src/acl/permissions.ts';
import manifest from '../module.json' with { type: 'json' };
import catalog from '../src/cli/commands.json' with { type: 'json' };
import { cliExtension } from '../src/cli/index.ts';
import { AUDIT_ERASURE_CAPABILITY } from '../src/services/erasure-port.ts';

describe('audit.core', () => {
	it('exports its validated identity', () => {
		expect(moduleDefinition.manifest.id).toBe('audit.core');
		expect(moduleDefinition.permissions).toEqual([
			'audit.registry.read',
			'audit.retention.manage',
			'audit.holds.manage',
		]);
		for (const permission of Object.values(AUDIT_PERMISSIONS)) {
			expect(permission).toMatch(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
		}
	});

	/* The data class registry is the platform's, handed to every module as
	   context.dataClasses, so audit.core provides no capability for it. The one
	   capability it does provide is the erasure port, which exists only because
	   the kernel declaration has no erase member yet. */
	it('provides the erasure port and nothing else', () => {
		expect(manifest.provides).toEqual([AUDIT_ERASURE_CAPABILITY]);
		expect('requires' in manifest).toBe(false);
	});

	/* The runner refuses a command whose implementation and catalogue differ,
	   down to the summary, so the two files are compared here as well. */
	it('keeps the CLI catalogue and the implementation identical', () => {
		expect(cliExtension.moduleId).toBe(catalog.moduleId);
		expect(
			cliExtension.commands.map((command) => ({
				path: [...command.path],
				capability: { ...command.capability },
			})),
		).toEqual(
			catalog.commands.map((command) => ({
				path: [...command.path],
				capability: { ...command.capability },
			})),
		);
	});
});
