import { describe, expect, it, vi } from 'vitest';
import { DatabaseMigrationError } from '@flowdular/database';
import { activatePreviewDrafts } from '../src/server/preview-runtime.ts';

function draft(
	name: string,
	events: string[],
	options: { readonly failPrepare?: boolean } = {},
) {
	return {
		routes: [],
		prepare() {
			events.push(`${name}:prepare`);
			if (options.failPrepare) throw new Error(`${name}:rejected`);
		},
		start() {
			events.push(`${name}:start`);
		},
		async startWorker() {
			events.push(`${name}:worker`);
		},
		dispose() {
			events.push(`${name}:dispose`);
		},
	};
}

describe('preview generation lifecycle', () => {
	it('prepares every draft before retiring the previous generation or starting', async () => {
		const events: string[] = [];
		await activatePreviewDrafts(
			[draft('first', events), draft('second', events)],
			() => {
				events.push('previous:dispose');
			},
		);

		expect(events).toEqual([
			'first:prepare',
			'second:prepare',
			'previous:dispose',
			'first:start',
			'second:start',
			'first:worker',
			'second:worker',
		]);
	});

	it('reports a draft worker that fails to start and still starts the rest', async () => {
		const events: string[] = [];
		const errors = await activatePreviewDrafts(
			[
				{
					...draft('first', events),
					async startWorker() {
						throw new Error('first:worker failed');
					},
				},
				draft('second', events),
			],
			() => undefined,
		);

		expect(errors).toEqual(['first:worker failed']);
		expect(events).toContain('second:worker');
	});

	it('disposes only the candidate when a later prepare hook fails', async () => {
		const events: string[] = [];
		const retireCurrent = vi.fn(() => {
			events.push('previous:dispose');
		});
		await expect(
			activatePreviewDrafts(
				[
					draft('first', events),
					draft('second', events, { failPrepare: true }),
				],
				retireCurrent,
			),
		).rejects.toThrow('second:rejected');

		expect(events).toEqual([
			'first:prepare',
			'second:prepare',
			'second:dispose',
			'first:dispose',
		]);
		expect(retireCurrent).not.toHaveBeenCalled();
	});

	/* A pre-0.6 session keeps its own preview database. The runner's refusal
	   tells an operator to reset the host database, the wrong remedy here. */
	it('tells a pre-0.6 session to delete itself instead of resetting the host', async () => {
		const refusal = new DatabaseMigrationError(
			'LEGACY_DATABASE',
			'',
			'This database was created by Flowdular 0.5 or earlier. ' +
				'Local embedded database: delete .flowdular/data/pglite. '.repeat(10),
		);
		const errors = await activatePreviewDrafts(
			[
				{
					routes: [],
					start() {
						throw refusal;
					},
				},
				{
					routes: [],
					start() {
						throw new Error('draft:failed');
					},
				},
			],
			() => undefined,
		);

		expect(errors).toHaveLength(2);
		expect(errors[0]).toContain('Delete the session');
		expect(errors[0]).not.toContain('.flowdular/data/pglite');
		expect(errors[0]!.length).toBeLessThanOrEqual(400);
		expect(errors[1]).toBe('draft:failed');
	});
});
