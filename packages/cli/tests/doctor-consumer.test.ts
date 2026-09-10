import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runDoctor } from '../src/doctor.ts';

it('checks configured SDK agent resources without requiring the authoring packages directory', async () => {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-doctor-consumer-'));
	try {
		await cp(resolve('../create-flowdular/template/default'), root, {
			recursive: true,
		});
		const sdk = join(root, 'platform/node_modules/@flowdular/sdk');
		await mkdir(join(sdk, '.ai/policies'), { recursive: true });
		await mkdir(join(sdk, '.ai/blueprints/example'), { recursive: true });
		await mkdir(join(sdk, 'modules/system'), { recursive: true });
		await writeFile(
			join(sdk, 'package.json'),
			JSON.stringify({
				name: '@flowdular/sdk',
				exports: { './modules.json': './modules.json' },
			}),
		);
		await writeFile(
			join(sdk, 'modules.json'),
			JSON.stringify({
				schemaVersion: 1,
				modules: [
					{
						manifest: 'modules/system/module.json',
						import: '@flowdular/sdk/modules/system',
					},
				],
			}),
		);
		await cp(
			resolve('../../modules/system/module.json'),
			join(sdk, 'modules/system/module.json'),
		);
		await writeFile(
			join(sdk, '.ai/policies/capabilities.yaml'),
			'schemaVersion: 1\n',
		);
		await writeFile(
			join(sdk, '.ai/policies/model-routing.yaml'),
			'schemaVersion: 1\n',
		);
		await writeFile(join(sdk, '.ai/blueprints/example/blueprint.json'), '{}');
		const configPath = join(root, 'flowdular.json');
		const config = JSON.parse(await readFile(configPath, 'utf8'));
		config.modules.enabled = [];
		await writeFile(configPath, JSON.stringify(config));
		const checks = await runDoctor({ root, configPath, config });
		expect(checks.filter((check) => check.status === 'fail')).toEqual([]);
		expect(
			checks.find((check) => check.id === 'blueprints.discovered')?.status,
		).toBe('pass');
		await rm(join(sdk, '.ai/policies/capabilities.yaml'));
		expect(
			(await runDoctor({ root, configPath, config })).find(
				(check) => check.id === 'policy.capabilities',
			)?.status,
		).toBe('fail');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
