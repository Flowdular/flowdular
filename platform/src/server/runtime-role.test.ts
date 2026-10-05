import type { ModuleServerComposition } from '@flowdular/server';
import { describe, expect, it } from 'vitest';
import { platformRuntimeRole, startModuleWorkers } from './runtime-role.ts';

function composition(
	startWorker?: () => void | Promise<void>,
): ModuleServerComposition {
	return { routes: [], ...(startWorker ? { startWorker } : {}) };
}

describe('platform runtime role', () => {
	it('defaults to combined so existing hosts keep their workers', () => {
		expect(platformRuntimeRole({})).toBe('combined');
		expect(platformRuntimeRole({ FD_RUNTIME_ROLE: ' ' })).toBe('combined');
		expect(platformRuntimeRole({ FD_RUNTIME_ROLE: 'web' })).toBe('web');
		expect(platformRuntimeRole({ FD_RUNTIME_ROLE: 'tick' })).toBe('tick');
	});

	it('refuses an unknown role instead of guessing one', () => {
		expect(() => platformRuntimeRole({ FD_RUNTIME_ROLE: 'worker' })).toThrow(
			'FD_RUNTIME_ROLE must be "combined", "web" or "tick".',
		);
	});
});

describe('module worker start', () => {
	it('awaits every worker in composition order in the combined role', async () => {
		const order: string[] = [];
		let releaseFirst!: () => void;
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const started = startModuleWorkers(
			[
				composition(async () => {
					order.push('first:start');
					await first;
					order.push('first:ready');
				}),
				composition(),
				composition(() => {
					order.push('second');
				}),
			],
			'combined',
		);
		await Promise.resolve();
		expect(order).toEqual(['first:start']);
		releaseFirst();
		await started;
		expect(order).toEqual(['first:start', 'first:ready', 'second']);
	});

	it('starts no worker at boot in the web and tick roles', async () => {
		let calls = 0;
		for (const role of ['web', 'tick'] as const) {
			await startModuleWorkers(
				[
					composition(() => {
						calls += 1;
					}),
				],
				role,
			);
		}
		expect(calls).toBe(0);
	});

	it('fails the boot when a worker cannot start and starts none after it', async () => {
		let later = 0;
		await expect(
			startModuleWorkers(
				[
					composition(async () => {
						throw new Error('reconciliation failed');
					}),
					composition(() => {
						later += 1;
					}),
				],
				'combined',
			),
		).rejects.toThrow('reconciliation failed');
		expect(later).toBe(0);
	});
});
