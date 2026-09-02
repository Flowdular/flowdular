import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { previewEnvironment } from '../src/server/preview-runtime.ts';
import type { SessionModule } from '../src/server/sessions.ts';

const DATA = join('/sessions', 'a1b2', 'data');

function module(id: string, directory: string): SessionModule {
	return { id, directory, kind: 'new' };
}

describe('preview environment', () => {
	it('points a draft database at the session data directory', () => {
		const environment = previewEnvironment({}, DATA, [
			module('expenses.core', 'expenses'),
		]);

		expect(environment.CL_EXPENSES_DATABASE).toBe(
			join(DATA, 'preview-expenses.db'),
		);
	});

	it('gives every module in the session its own file', () => {
		const environment = previewEnvironment({}, DATA, [
			module('expenses.core', 'expenses'),
			module('parties.core', 'parties'),
		]);

		expect(environment.CL_EXPENSES_DATABASE).toBe(
			join(DATA, 'preview-expenses.db'),
		);
		expect(environment.CL_PARTIES_DATABASE).toBe(
			join(DATA, 'preview-parties.db'),
		);
	});

	/* Core spells the variable from the namespace in one place and from the
	   package suffix in another. They differ for a two-segment id. */
	it('sets both spellings a longer module id can resolve', () => {
		const environment = previewEnvironment({}, DATA, [
			module('sales.orders', 'sales-orders'),
		]);

		const file = join(DATA, 'preview-sales-orders.db');
		expect(environment.CL_SALES_DATABASE).toBe(file);
		expect(environment.CL_SALES_ORDERS_DATABASE).toBe(file);
	});

	it('keeps the rest of the environment and leaves the source untouched', () => {
		const base = { NODE_ENV: 'production', CL_EXPENSES_DATABASE: '/data/x.db' };

		const environment = previewEnvironment(base, DATA, [
			module('expenses.core', 'expenses'),
		]);

		expect(environment.NODE_ENV).toBe('production');
		expect(environment.CL_EXPENSES_DATABASE).toBe(
			join(DATA, 'preview-expenses.db'),
		);
		expect(base.CL_EXPENSES_DATABASE).toBe('/data/x.db');
	});
});
