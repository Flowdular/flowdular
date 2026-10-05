// @vitest-environment jsdom
import { act, createRoot, setIsOctaneActEnvironment } from 'octane';
import { afterEach, beforeAll, expect, it } from 'vitest';
import type { ModuleChangePlan } from '@flowdular/contracts';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
import { ModuleStudioView } from '../src/client/ModuleStudioView.tsrx';
import type { ModuleStudioState } from '../src/server/module-studio.ts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';

setIsOctaneActEnvironment(true);

beforeAll(() => {
	registerModuleTranslations([
		{
			moduleId: 'system.core',
			translations: { en: translationsEn, pl: translationsPl },
		},
	]);
	setActiveLocale('en');
});

const plannedHash = 'b'.repeat(64);
const installedHash = 'a'.repeat(64);
const plan: ModuleChangePlan = {
	schemaVersion: 1,
	id: 'c'.repeat(64),
	createdAt: '2026-10-04T00:00:00.000Z',
	target: 'sample.core',
	sourceName: 'local',
	source: { kind: 'catalog', location: './registry/index.json' },
	update: true,
	expectedLockSha256: 'd'.repeat(64),
	expectedWorkspaceSha256: 'e'.repeat(64),
	releases: [
		{
			manifest: {
				schemaVersion: 1,
				id: 'sample.core',
				package: '@flowdular/module-sample',
				version: '2.0.0',
				profile: 'full',
				capabilities: ['api'],
				dependencies: [],
				tenancy: 'required',
				locales: ['en'],
				stability: 'stable',
			},
			artifact: 'sample.json',
			sha256: plannedHash,
			sourceCommit: 'f'.repeat(40),
			license: 'MIT',
		},
	],
	changes: [
		{
			id: 'sample.core',
			version: '2.0.0',
			sha256: plannedHash,
			action: 'update',
			dependencies: [],
			permissions: [],
			migrations: [],
			surfaces: { server: true, client: false },
		},
	],
	requiresBuild: true,
	requiresRestart: true,
	activation: 'host-cli',
};

const studio: ModuleStudioState = {
	sources: [],
	plans: [plan],
	installed: [
		{
			id: 'sample.core',
			version: '1.0.0',
			directory: 'sample',
			sha256: installedHash,
			artifact: 'sample-v1.json',
			sourceCommit: '9'.repeat(40),
			files: {},
		},
	],
	issues: [],
};

let unmount: (() => void) | undefined;
afterEach(() => {
	unmount?.();
	unmount = undefined;
});

it(
	'shows the installed artifact hash beside a different planned hash',
	async () => {
		const container = document.createElement('div');
		document.body.append(container);
		const root = createRoot(container);
		unmount = () => {
			root.unmount();
			container.remove();
		};
		await act(async () => {
			root.render(
				<ModuleStudioView
					studio={studio}
					modules={[]}
					sandboxAvailable={false}
					commands={{}}
				/>,
			);
		});
		const cells = [...container.querySelectorAll('.ui-cell')].map(
			(cell) => cell.textContent?.trim(),
		);
		expect(cells).toContain(`Artifact SHA-256${plannedHash}`);
		expect(cells).toContain(`Installed SHA-256${installedHash}`);
		expect(container.textContent).toContain('Planned');
	},
);
