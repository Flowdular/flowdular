// @vitest-environment jsdom
import { act, createRoot, setIsOctaneActEnvironment } from 'octane';
import { afterEach, beforeAll, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
} from '@flowdular/client/i18n';
import { ModuleSettingRow } from '../src/client/ModuleSettingRow.tsrx';
import type { SettingsEntryPayload } from '../src/server/endpoints.ts';
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
});

/* What GET /api/settings answers a workspace other than the operator's. */
const locked = {
	locked: 'This setting applies to every workspace; only the deployment operator\'s workspace can change it.',
	lockedKey: 'system.settings.platformOperatorOnly',
} as const;

const appName: SettingsEntryPayload = {
	key: 'appName',
	type: 'string',
	scope: 'platform',
	label: 'Application name',
	description: 'Shown in the navigation.',
	value: 'Acme Operations',
	hasValue: true,
	defaultValue: 'Flowdular',
	secret: false,
	...locked,
};

const allowSignUp: SettingsEntryPayload = {
	key: 'allowSignUp',
	type: 'boolean',
	scope: 'platform',
	label: 'Allow sign-up',
	description: 'Visitors can create a new workspace.',
	value: true,
	hasValue: false,
	defaultValue: true,
	secret: false,
	...locked,
};

let unmount: (() => void) | undefined;
afterEach(() => {
	unmount?.();
	unmount = undefined;
	setActiveLocale('en');
});

async function render(setting: SettingsEntryPayload): Promise<HTMLElement> {
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	unmount = () => {
		root.unmount();
		container.remove();
	};
	await act(async () => {
		root.render(
			<ModuleSettingRow
				setting={setting}
				canManage={true}
				busy={false}
				showScope={true}
				result={null}
				onSave={() => {
					throw new Error('A locked row must not save.');
				}}
			/>,
		);
	});
	return container;
}

it.each([
	['en', 'Applies to every workspace'],
	['pl', 'tylko przestrzeń robocza operatora wdrożenia'],
])(
	'SYSTEM-BRANDING-READ shows a platform row read-only outside the operator workspace in %s',
	async (locale, hint) => {
		setActiveLocale(locale);
		const row = await render(appName);
		const input = row.querySelector('input') as HTMLInputElement;
		expect(input.disabled).toBe(true);
		for (const button of row.querySelectorAll('button')) {
			expect((button as HTMLButtonElement).disabled).toBe(true);
		}
		expect(row.textContent).toContain(hint);
	},
);

it.each([
	['en', 'Applies to every workspace, and no workspace is recorded'],
	['pl', 'żadna przestrzeń robocza nie jest jeszcze zapisana jako operator'],
])(
	'SYSTEM-SETTINGS-PLATFORM-UNCONFIGURED shows a platform row read-only with the unset reason in %s',
	async (locale, hint) => {
		setActiveLocale(locale);
		const row = await render({
			...appName,
			locked: 'This setting applies to every workspace, and no workspace is recorded as this deployment\'s operator yet. Record one with pnpm flowdular auth operator-set on the deployment.',
			lockedKey: 'system.settings.platformOperatorUnset',
		});
		const input = row.querySelector('input') as HTMLInputElement;
		expect(input.disabled).toBe(true);
		expect(row.textContent).toContain(hint);
		expect(row.textContent).toContain('pnpm flowdular auth operator-set');
	},
);

it(
	'SYSTEM-SETTINGS-READ disables the switch of a locked platform boolean',
	async () => {
		const row = await render(allowSignUp);
		const toggles = row.querySelectorAll('input, button');
		expect(toggles.length).toBeGreaterThan(0);
		for (const control of toggles) {
			expect((control as HTMLInputElement | HTMLButtonElement).disabled).toBe(
				true,
			);
		}
		expect(row.textContent).toContain('only the deployment operator');
	},
);
