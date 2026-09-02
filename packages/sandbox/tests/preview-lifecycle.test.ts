import { describe, expect, it, vi } from 'vitest';
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
		]);
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
});
