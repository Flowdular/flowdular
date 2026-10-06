import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnCommand } from '../src/server/delivery/steps.ts';
import { runBoundedProcess } from '../src/server/process-command.ts';
import {
	cleanupPlatformTests,
	platformWorkspace,
	readLedger,
	recordedFixtures,
	recordProcessSource,
	survivorsAfter,
} from './support/platform-processes.ts';

afterEach(cleanupPlatformTests);

/** A command whose grandchild ignores SIGTERM; with `stubborn`, so does the
    command itself. Both record themselves. */
function commandTreeSource(
	ledger: string,
	options: { readonly stubborn: boolean; readonly heartbeat?: string },
): string {
	const ignoreTerm = "process.on('SIGTERM', () => {});\n";
	const beat = options.heartbeat
		? `appendFileSync(${JSON.stringify(options.heartbeat)}, 'x');`
		: '';
	const grandchild = `${recordProcessSource(ledger)}import { appendFileSync } from 'node:fs';
${ignoreTerm}setInterval(() => {${beat}}, 20);
`;
	return `${recordProcessSource(ledger)}import { spawn } from 'node:child_process';
${options.stubborn ? ignoreTerm : ''}spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
setInterval(() => {}, 1000);
`;
}

describe('delivery subprocess limits', () => {
	it('stops a hung command and reports the timeout', async () => {
		const workspace = await platformWorkspace('flowdular-process-command-');
		const hung = join(workspace.root, 'hung.mjs');
		await writeFile(
			hung,
			`${recordProcessSource(workspace.ledger)}process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`,
		);
		const started = Date.now();
		const result = await spawnCommand(
			process.execPath,
			[hung],
			workspace.root,
			{ timeoutMs: 1_500 },
		);
		expect(result.code).toBeNull();
		expect(result.output).toContain('Command timed out');
		expect(Date.now() - started).toBeLessThan(5_000);
		const recorded = await readLedger(workspace.ledger);
		expect(recorded).toHaveLength(1);
		expect(await survivorsAfter(recorded, 2_000)).toEqual([]);
	});

	it.skipIf(process.platform === 'win32')(
		'waits for a stubborn grandchild after its parent exits on timeout',
		async () => {
			const workspace = await platformWorkspace('flowdular-process-group-');
			const heartbeat = join(workspace.root, 'heartbeat');
			const parent = join(workspace.root, 'parent.mjs');
			await writeFile(
				parent,
				commandTreeSource(workspace.ledger, { stubborn: false, heartbeat }),
			);
			const result = await runBoundedProcess(process.execPath, [parent], {
				cwd: workspace.root,
				env: process.env,
				timeoutMs: 1_500,
				outputLimit: 0,
			});
			expect(result).toMatchObject({ code: null, timedOut: true });
			const before = await readFile(heartbeat, 'utf8');
			expect(before.length).toBeGreaterThan(0);
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
			expect(await readFile(heartbeat, 'utf8')).toBe(before);
		},
	);

	it('reports a command that cannot be started', async () => {
		const workspace = await platformWorkspace('flowdular-process-missing-');
		const result = await runBoundedProcess(
			'flowdular-missing-command',
			['--version'],
			{
				cwd: workspace.root,
				env: process.env,
				timeoutMs: 30_000,
				outputLimit: 1_000,
			},
		);
		expect(result).toEqual({
			code: null,
			output: 'spawn flowdular-missing-command ENOENT',
			timedOut: false,
		});
	});

	it.skipIf(process.platform === 'win32')(
		'stops the command tree when the process that started it dies',
		async () => {
			const workspace = await platformWorkspace('flowdular-process-orphan-');
			const command = join(workspace.root, 'command.mjs');
			await writeFile(
				command,
				commandTreeSource(workspace.ledger, { stubborn: true }),
			);
			const processCommand = new URL(
				'../src/server/process-command.ts',
				import.meta.url,
			).href;
			/* A launcher running a bootstrap command far from its timeout. */
			const launcher = spawn(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`import { runBoundedProcess } from ${JSON.stringify(processCommand)};
await runBoundedProcess(process.execPath, [${JSON.stringify(command)}], { cwd: ${JSON.stringify(workspace.root)}, env: process.env, timeoutMs: 600_000, outputLimit: 0 });
`,
				],
				{ stdio: 'ignore' },
			);
			if (launcher.pid !== undefined)
				appendFileSync(workspace.ledger, `${launcher.pid}\n`);
			const recorded = await recordedFixtures(workspace.ledger, 2);
			launcher.kill('SIGKILL');
			/* The guard sends SIGTERM, then SIGKILL a second later. */
			expect(await survivorsAfter(recorded, 10_000)).toEqual([]);
		},
	);
});
