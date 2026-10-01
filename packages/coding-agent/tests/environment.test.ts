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
