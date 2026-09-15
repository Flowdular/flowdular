import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModuleClientContribution } from '../src/contributions.ts';
import {
	contributionsForActiveModules,
	loadActiveModules,
} from '../src/shell/modules.ts';

const contributions: readonly ModuleClientContribution[] = [
	{ moduleId: 'system.core' },
	{ moduleId: 'auth.core' },
	{ moduleId: 'reports.core' },
	{ moduleId: 'metering.core' },
];

const ids = (list: readonly ModuleClientContribution[]) =>
	list.map((contribution) => contribution.moduleId);

const context = {
	accountId: 'account',
	tenantId: 'tenant',
	signal: new AbortController().signal,
};

afterEach(() => vi.unstubAllGlobals());

describe('active module filtering', () => {
	it('keeps required modules and the active optional ones', () => {
		expect(
			ids(contributionsForActiveModules(contributions, ['metering.core'])),
		).toEqual(['system.core', 'auth.core', 'metering.core']);
	});

	it('shows every module when the activation could not be read', () => {
		expect(ids(contributionsForActiveModules(contributions, null))).toEqual(
			ids(contributions),
		);
	});

	it('reads the active ids from system.core and answers null for anything else', async () => {
		const fetchMock = vi.fn(async (input: string, _init?: RequestInit) =>
			input === '/api/system/modules/active'
				? Response.json({ modules: ['reports.core'] })
				: Response.json({}, { status: 404 }),
		);
		vi.stubGlobal('fetch', fetchMock);
		expect(await loadActiveModules(context)).toEqual(['reports.core']);
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
			credentials: 'same-origin',
		});

		vi.stubGlobal('fetch', async () => Response.json({}, { status: 403 }));
		expect(await loadActiveModules(context)).toBeNull();

		vi.stubGlobal('fetch', async () => Response.json({ modules: [1] }));
		expect(await loadActiveModules(context)).toBeNull();

		vi.stubGlobal('fetch', async () => {
			throw new TypeError('offline');
		});
		expect(await loadActiveModules(context)).toBeNull();
	});
});
