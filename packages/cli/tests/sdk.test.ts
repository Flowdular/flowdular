import { expect, it } from 'vitest';
import { sdkScaffold, sdkSource } from '../src/sdk.ts';

it('keeps the standalone sandbox distinct from the SDK sandbox access module', () => {
	expect(sdkSource("import '@flowdular/sandbox/server';")).toBe(
		"import '@flowdular/sandbox/server';",
	);
	expect(sdkSource("import '@flowdular/module-sandbox/server';")).toBe(
		"import '@flowdular/sdk/modules/sandbox/server';",
	);
});

it('preserves the approved specification and module identity byte for byte while adapting generated imports', () => {
	const specification =
		'id: example.core\nrequirements:\n  - Follow the @flowdular/contracts contract exactly.\n';
	const manifest = JSON.stringify({
		id: 'example.core',
		package: '@flowdular/module-example',
	});
	const files = sdkScaffold(
		new Map([
			['spec/module.yaml', specification],
			['module.json', manifest],
			[
				'src/index.ts',
				"import type {ModuleManifest} from '@flowdular/contracts';",
			],
			[
				'package.json',
				JSON.stringify({
					name: '@flowdular/module-example',
					dependencies: {
						'@flowdular/contracts': 'workspace:*',
						octane: '0.1.51',
					},
					devDependencies: {
						'@flowdular/database-testing': 'workspace:*',
						vitest: '4.1.11',
					},
				}),
			],
		]),
	);
	expect(files.get('spec/module.yaml')).toBe(specification);
	expect(files.get('module.json')).toBe(manifest);
	expect(files.get('src/index.ts')).toContain(
		"from '@flowdular/sdk/contracts'",
	);
	expect(JSON.parse(files.get('package.json')!)).toEqual({
		name: '@flowdular/module-example',
		dependencies: { octane: '0.1.51', '@flowdular/sdk': '0.2.1' },
		devDependencies: { vitest: '4.1.11' },
	});
});
