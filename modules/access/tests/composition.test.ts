import { describe, expect, it } from 'vitest';
import type { DefinedListExport } from '@flowdular/server';
import type { PlatformServerContext } from '@flowdular/module-auth/server';
import { createServerComposition } from '../src/platform.ts';
import { EXPORT_LISTS_CAPABILITY } from '../src/services/list-exports.ts';

interface Registered {
	readonly moduleId: string;
	readonly exports: readonly DefinedListExport[];
}

/**
 * The pieces of the platform context this composition touches. No database is
 * opened: the runtime acquires its leases on the first request, so a case can
 * compose the module and read what it declared.
 */
function context(options: { readonly exportsPresent: boolean }) {
	const declared: string[] = [];
	const registrations: Registered[] = [];
	const registry = {
		register: (moduleId: string, exports: readonly DefinedListExport[]) => {
			registrations.push({ moduleId, exports });
		},
	};
	let present = options.exportsPresent;
	const value = {
		environment: { NODE_ENV: 'test' },
		auth: { service: async () => ({}) },
		databases: {
			acquire: () => Promise.reject(new Error('No database in this case.')),
			dispose: () => Promise.resolve(),
		},
		dataClasses: {
			declare: (moduleId: string) => {
				declared.push(moduleId);
			},
		},
		capabilities: {
			get: (id: string) =>
				present && id === EXPORT_LISTS_CAPABILITY ? registry : null,
		},
	};
	return {
		context: value as unknown as PlatformServerContext,
		declared,
		registrations,
		/** exports.core composing after this module did. */
		arrive: () => {
			present = true;
		},
	};
}

describe('access.core composition', () => {
	it('declares its data class and its routes', () => {
		const platform = context({ exportsPresent: false });

		const composition = createServerComposition(platform.context);

		expect(platform.declared).toEqual(['access.core']);
		expect(composition.routes.map((route) => route.path)).toEqual([
			'/api/access/review',
			'/api/access/diff',
			'/api/access/activity',
			'/api/access/attest',
			'/api/access/attestations',
		]);
	});

	it('registers its list exports when exports.core composed first', () => {
		const platform = context({ exportsPresent: true });

		const composition = createServerComposition(platform.context);
		composition.start?.();

		expect(platform.registrations).toHaveLength(1);
		expect(platform.registrations[0]!.moduleId).toBe('access.core');
		expect(platform.registrations[0]!.exports.map((entry) => entry.id)).toEqual(
			['access.core.review', 'access.core.attestations'],
		);
	});

	/* An optional requirement does not order its provider first, so the
	   capability can appear only after this module composed. The start hook is
	   the second chance, and it still runs before the provider seals. */
	it('registers them when exports.core composed after this module', () => {
		const platform = context({ exportsPresent: false });

		const composition = createServerComposition(platform.context);
		expect(platform.registrations).toEqual([]);
		platform.arrive();
		composition.start?.();

		expect(platform.registrations).toHaveLength(1);
	});

	it('registers nothing at all without exports.core, and registers once', () => {
		const absent = context({ exportsPresent: false });
		const present = context({ exportsPresent: true });

		const without = createServerComposition(absent.context);
		without.start?.();
		const withExports = createServerComposition(present.context);
		withExports.start?.();
		withExports.start?.();

		expect(absent.registrations).toEqual([]);
		expect(present.registrations).toHaveLength(1);
	});
});
