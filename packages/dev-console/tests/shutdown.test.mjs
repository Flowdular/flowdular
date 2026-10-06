import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

const shutdown = new URL('../src/shutdown.mjs', import.meta.url).href;
const children = [];

afterEach(() => {
	for (const child of children.splice(0))
		if (child.exitCode === null && child.signalCode === null)
			child.kill('SIGKILL');
});

/* The server's drain ends only when the test writes a line, so every repeat
   signal is pending before the drain can finish. The line also closes its
   input, so a drained server has nothing left to hold it open. */
function startServer(options = {}) {
	const source = `import { createInterface } from 'node:readline';
import { stopOnSignals } from ${JSON.stringify(shutdown)};
const keepAlive = setInterval(() => {}, 1000);
stopOnSignals(() => {
	console.log('stopping');
	createInterface({ input: process.stdin }).once('line', () => {
		clearInterval(keepAlive);
		console.log('drained');
	});
}, ${JSON.stringify(options)});
console.log('ready');
`;
	const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	children.push(child);
	let output = '';
	const printed = (line) =>
		new Promise((resolve, reject) => {
			const check = () => {
				if (output.split('\n').includes(line)) resolve();
			};
			child.stdout.on('data', check);
			child.once('exit', () =>
				reject(new Error(`exited before "${line}": ${output}`)),
			);
			check();
		});
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		output += chunk;
	});
	let errors = '';
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk) => {
		errors += chunk;
	});
	return { child, printed, output: () => output, errors: () => errors };
}

describe('development server stop signals', () => {
	it.each(['SIGTERM', 'SIGINT', 'SIGHUP'])(
		'finishes the drain when SIGTERM and SIGINT repeat after a %s',
		async (first) => {
			const server = startServer();
			await server.printed('ready');
			server.child.kill(first);
			await server.printed('stopping');
			server.child.kill('SIGTERM');
			server.child.kill('SIGINT');
			const exited = once(server.child, 'exit');
			server.child.stdin.end('finish\n');
			expect(await exited).toEqual([0, null]);
			expect(server.output().split('\n')).toEqual([
				'ready',
				'stopping',
				'drained',
				'',
			]);
		},
	);

	it('ends a stop that outlasts its deadline with status 1', async () => {
		const server = startServer({ deadlineMs: 300 });
		await server.printed('ready');
		const exited = once(server.child, 'exit');
		server.child.kill('SIGINT');
		expect(await exited).toEqual([1, null]);
		expect(server.output().split('\n')).toEqual(['ready', 'stopping', '']);
		expect(server.errors()).toBe(
			'Development server shutdown exceeded 300 ms.\n',
		);
	});

	it('lets a stop that drains within its deadline exit at once', async () => {
		const server = startServer({ deadlineMs: 60_000 });
		await server.printed('ready');
		server.child.kill('SIGINT');
		await server.printed('stopping');
		const exited = once(server.child, 'exit');
		server.child.stdin.end('finish\n');
		expect(await exited).toEqual([0, null]);
		expect(server.errors()).toBe('');
	});
});
