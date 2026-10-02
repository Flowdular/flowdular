import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	agentEnvironment,
	probeEnvironment,
	withheldEnvironmentKeys,
} from '../src/environment.ts';
import { spawnLineStream } from '../src/workspace.ts';

/* The operator's shell is not the agent's shell. Anything exported there is
   readable by a model and by anything the model runs, so the drivers get an
   allowlist and the runtime drops credential-shaped names outright. */
describe('agent process environment', () => {
	it('keeps PATH and HOME so the binary still starts', () => {
		const env = agentEnvironment('claude-code', {
			PATH: '/usr/bin',
			HOME: '/h',
		});
		expect(env.PATH).toBe('/usr/bin');
		expect(env.HOME).toBe('/h');
	});

	it('drops a database URL an operator exported', () => {
		const env = agentEnvironment('claude-code', {
			PATH: '/usr/bin',
			DATABASE_URL: 'postgres://user:pw@host/db',
		});
		expect(env.DATABASE_URL).toBeUndefined();
	});

	it('drops every credential-shaped name the operator exported', () => {
		const env = agentEnvironment('claude-code', {
			PATH: '/usr/bin',
			AWS_SECRET_ACCESS_KEY: 'k',
			AWS_SESSION_TOKEN: 't',
			GH_TOKEN: 'g',
			SOME_SERVICE_PASSWORD: 'p',
			FD_PLATFORM_TOKEN: 'f',
			PGPASSWORD: 'd',
		});
		expect(Object.keys(env).sort()).toEqual(['PATH']);
	});

	it('gives each driver only its own provider key', () => {
		const source = {
			PATH: '/usr/bin',
			ANTHROPIC_API_KEY: 'anthropic',
			OPENAI_API_KEY: 'openai',
		};
		expect(agentEnvironment('claude-code', source).ANTHROPIC_API_KEY).toBe(
			'anthropic',
		);
		expect(
			agentEnvironment('claude-code', source).OPENAI_API_KEY,
		).toBeUndefined();
		expect(agentEnvironment('codex', source).OPENAI_API_KEY).toBe('openai');
		expect(agentEnvironment('codex', source).ANTHROPIC_API_KEY).toBeUndefined();
	});

	it('reports what it withheld so a drop is never silent', () => {
		expect(
			withheldEnvironmentKeys('claude-code', {
				PATH: '/usr/bin',
				DATABASE_URL: 'postgres://x',
				AWS_SECRET_ACCESS_KEY: 'k',
				HOME: '/h',
			}),
		).toEqual(['AWS_SECRET_ACCESS_KEY', 'DATABASE_URL']);
	});

	it('gives a version probe PATH and nothing else', () => {
		expect(
			Object.keys(
				probeEnvironment({ PATH: '/bin', DATABASE_URL: 'x', HOME: '/h' }),
			).sort(),
		).toEqual(['HOME', 'PATH']);
	});
});

/* The regression that matters: spawnLineStream used to fall back to
   process.env, so a driver with no explicit env inherited the operator's
   DATABASE_URL. This proves the child no longer sees it. */
describe('spawnLineStream environment', () => {
	const directories: string[] = [];
	afterEach(async () => {
		await Promise.all(
			directories.splice(0).map((d) => rm(d, { recursive: true })),
		);
	});

	it('passes an empty environment when none is given', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'flowdular-env-'));
		directories.push(directory);
		const script = join(directory, 'echo.mjs');
		await writeFile(
			script,
			'process.stdout.write(JSON.stringify(process.env));',
		);

		process.env.DATABASE_URL = 'postgres://leak';
		try {
			const stream = spawnLineStream({
				command: process.execPath,
				args: [script],
				cwd: directory,
			});
			let raw = '';
			for await (const line of stream.lines) raw += line;
			await stream.finished;
			expect(JSON.parse(raw).DATABASE_URL).toBeUndefined();
		} finally {
			delete process.env.DATABASE_URL;
		}
	});

	it('passes the caller environment through unchanged', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'flowdular-env-'));
		directories.push(directory);
		const script = join(directory, 'echo.mjs');
		await writeFile(
			script,
			'process.stdout.write(process.env.FD_MARKER ?? "");',
		);

		const stream = spawnLineStream({
			command: process.execPath,
			args: [script],
			cwd: directory,
			env: { FD_MARKER: 'present' },
		});
		let raw = '';
		for await (const line of stream.lines) raw += line;
		await stream.finished;
		expect(raw).toBe('present');
	});
});

describe('spawnLineStream cancellation', () => {
	it('stops a command descendant that ignores SIGTERM and holds the output pipe', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'flowdular-process-tree-'));
		const script = join(directory, 'parent.mjs');
		const pidFile = join(directory, 'child.pid');
		const heartbeat = join(directory, 'heartbeat');
		await writeFile(
			script,
			`import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const [pidFile, heartbeat] = process.argv.slice(2);
const descendant = spawn(process.execPath, ['-e',
  'const { writeFileSync } = require("node:fs"); ' +
  'process.on("SIGTERM", () => {}); ' +
  'writeFileSync(process.argv[1], String(Date.now())); ' +
  'setInterval(() => writeFileSync(process.argv[1], String(Date.now())), 40);',
  heartbeat], { stdio: 'inherit' });
writeFileSync(pidFile, String(descendant.pid));
const ready = setInterval(() => {
  if (!existsSync(heartbeat)) return;
  clearInterval(ready);
  process.stdout.write('ready\\n');
}, 10);
setInterval(() => {}, 1000);
`,
		);

		let descendantPid: number | undefined;
		let stopped = false;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		try {
			const controller = new AbortController();
			const stream = spawnLineStream({
				command: process.execPath,
				args: [script, pidFile, heartbeat],
				cwd: directory,
				signal: controller.signal,
			});
			const lines = (async () => {
				for await (const line of stream.lines) {
					if (line === 'ready') controller.abort();
				}
			})();
			const result = await Promise.race([
				Promise.all([lines, stream.finished]).then(([, exit]) => exit),
				new Promise<never>((_, reject) => {
					watchdog = setTimeout(
						() => reject(new Error('Cancelled process tree kept stdout open.')),
						4_000,
					);
				}),
			]);
			expect(result.aborted).toBe(true);
			descendantPid = Number(await readFile(pidFile, 'utf8'));
			const stoppedAt = await readFile(heartbeat, 'utf8');
			await new Promise((resolve) => setTimeout(resolve, 160));
			expect(await readFile(heartbeat, 'utf8')).toBe(stoppedAt);
			stopped = true;
		} finally {
			if (watchdog) clearTimeout(watchdog);
			if (!descendantPid) {
				try {
					descendantPid = Number(await readFile(pidFile, 'utf8'));
				} catch {
					// The child may have failed before it wrote its PID.
				}
			}
			if (!stopped && descendantPid) {
				try {
					process.kill(descendantPid, 'SIGKILL');
				} catch {
					// Already stopped by the process-tree cancellation.
				}
			}
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('bounds the wait when a detached descendant still owns stdout', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'flowdular-detached-'));
		const script = join(directory, 'parent.mjs');
		const pidFile = join(directory, 'child.pid');
		await writeFile(
			script,
			`import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: true,
  stdio: 'inherit',
});
writeFileSync(process.argv[2], String(descendant.pid));
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`,
		);
		let descendantPid: number | undefined;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		try {
			const controller = new AbortController();
			const stream = spawnLineStream({
				command: process.execPath,
				args: [script, pidFile],
				cwd: directory,
				signal: controller.signal,
			});
			const lines = (async () => {
				for await (const line of stream.lines) {
					if (line === 'ready') controller.abort();
				}
			})();
			const result = await Promise.race([
				Promise.all([lines, stream.finished]).then(([, exit]) => exit),
				new Promise<never>((_, reject) => {
					watchdog = setTimeout(
						() => reject(new Error('Cancelled turn did not close its stream.')),
						4_500,
					);
				}),
			]);
			expect(result.aborted).toBe(true);
		} finally {
			if (watchdog) clearTimeout(watchdog);
			try {
				descendantPid = Number(await readFile(pidFile, 'utf8'));
			} catch {
				// The child may have failed before it wrote its PID.
			}
			if (descendantPid) {
				try {
					process.kill(descendantPid, 'SIGKILL');
				} catch {
					// Already stopped by taskkill on Windows.
				}
			}
			await rm(directory, { recursive: true, force: true });
		}
	}, 6_000);
});
