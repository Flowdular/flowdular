import { spawnSync } from 'node:child_process';
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('builds against disposable development state even when deployment settings are present', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-build-isolation-'));
	try {
		const binary = join(root, 'vite');
		const report = join(root, 'report.json');
		const deployment = join(root, 'deployment-state');
		await mkdir(deployment);
		await writeFile(
			binary,
			`#!/usr/bin/env node
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.FD_BUILD_TEST_REPORT,JSON.stringify({mode:process.env.FD_ENV,build:process.env.FD_INTERNAL_BUILD,nodeEnv:process.env.NODE_ENV,adapter:process.env.FD_DATABASE_ADAPTER,directory:process.env.FD_DATABASE_PGLITE_DIRECTORY,key:process.env.FD_AGENT_CREDENTIAL_KEY}));
`,
		);
		await chmod(binary, 0o755);
		const result = spawnSync(
			process.execPath,
			[resolve(import.meta.dirname, '../../scripts/build.mjs')],
			{
				encoding: 'utf8',
				env: {
					...process.env,
					PATH: root + delimiter + process.env.PATH,
					FD_BUILD_TEST_REPORT: report,
					FD_ENV: 'production',
					NODE_ENV: 'production',
					FD_DATABASE_ADAPTER: 'postgresql',
					FD_DATABASE_PGLITE_DIRECTORY: deployment,
					FD_AGENT_CREDENTIAL_KEY: 'deployment-key',
				},
			},
		);
		expect(result.status, result.stderr).toBe(0);
		const observed = JSON.parse(await readFile(report, 'utf8'));
		expect(observed.mode).toBe('development');
		expect(observed.build).toBe('true');
		expect(observed.nodeEnv).toBe('production');
		expect(observed.adapter).toBe('pglite');
		expect(observed.directory).not.toBe(deployment);
		expect(observed.key).not.toBe('deployment-key');
		expect(Buffer.from(observed.key, 'base64')).toHaveLength(32);
		await expect(stat(observed.directory)).rejects.toMatchObject({
			code: 'ENOENT',
		});
		expect((await stat(deployment)).isDirectory()).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
