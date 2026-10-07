// @vitest-environment jsdom
import {
	act,
	createElement,
	createRoot,
	setIsOctaneActEnvironment,
} from 'octane';
import type { ModuleClientContribution } from '@flowdular/client';
import { afterEach, expect, it, vi } from 'vitest';
import { registerSandboxTranslations } from '../src/client/i18n.ts';
import { PreviewHost } from '../src/preview/PreviewHost.tsrx';

setIsOctaneActEnvironment(true);

const SESSION = '8f7a170f-35d5-4d1b-853a-16c3bebf6b89';

const SYSTEM: ModuleClientContribution = {
	moduleId: 'system.core',
	navigation: [
		{
			id: 'system.navigation.modules',
			viewId: 'modules',
			group: 'Administration',
			label: 'Platform',
			glyph: 'modules',
			description: 'Platform',
			scope: 'system.settings.manage',
			order: 10,
		},
	],
	views: [
		{
			id: 'modules',
			render: () =>
				createElement('p', { class: 'platform-screen' }, 'Platform'),
		},
	],
};

const EQUIPMENT: ModuleClientContribution = {
	moduleId: 'equipment.core',
	navigation: [
		{
			id: 'equipment.navigation',
			viewId: 'equipment',
			group: 'Operations',
			label: 'Equipment',
			glyph: 'catalog',
			description: 'Equipment',
			scope: 'equipment.items.read',
			order: 50,
		},
	],
	views: [
		{
			id: 'equipment',
			render: () =>
				createElement('p', { class: 'equipment-screen' }, 'Equipment items'),
		},
	],
};

vi.mock('../src/preview/load-module.ts', () => ({
	importDraftModule: async (entry: string) => ({
		createClientContribution: () =>
			entry.includes('/preview-support/') ? SYSTEM : EQUIPMENT,
	}),
}));

const PRINCIPAL = {
	accountId: 'account-1',
	email: 'preview@sandbox.local',
	displayName: 'Sandbox preview',
	role: 'owner',
	scopes: ['system.workspace.access', 'system.settings.manage'],
	tenantId: 'tenant-1',
	tenants: [
		{ tenantId: 'tenant-1', name: 'Preview', slug: 'preview', role: 'owner' },
	],
};

/* What the session's preview answers when the draft depends on system.core:
   system.core composes as a support module, and its activation catalog lists
   nothing of the session. */
const ANSWERS: Record<string, unknown> = {
	[`/sandbox/api/sessions/${SESSION}`]: {
		session: { id: SESSION, moduleId: 'equipment.core' },
	},
	[`/sandbox/api/sessions/${SESSION}/preview`]: {
		credentials: { email: 'preview@sandbox.local', password: 'preview' },
		scopes: ['equipment.items.read'],
		modules: [
			{
				id: 'system.core',
				directory: 'system',
				hasClient: true,
				support: true,
			},
			{ id: 'equipment.core', directory: 'equipment', hasClient: true },
		],
		error: null,
	},
	'/api/auth/sign-in': { principal: PRINCIPAL, csrfToken: 'csrf' },
	'/api/system/modules/active': { modules: [] },
};

const requested: string[] = [];
let teardown: (() => void) | undefined;

afterEach(() => {
	teardown?.();
	teardown = undefined;
	requested.length = 0;
	document.cookie = 'flowdular_preview=; path=/; max-age=0';
	vi.unstubAllGlobals();
});

async function openPreview(address: string): Promise<HTMLElement> {
	vi.stubGlobal('fetch', async (input: string) => {
		const path = new URL(input, 'http://sandbox.local').pathname;
		requested.push(path);
		return path in ANSWERS
			? Response.json(ANSWERS[path])
			: Response.json({ error: { message: 'Not found' } }, { status: 404 });
	});
	/* A page load registers the sandbox catalog; the shell replaces it with the
	   modules' own once it renders. */
	registerSandboxTranslations();
	history.replaceState(null, '', address);
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	teardown = () => {
		root.unmount();
		container.remove();
	};
	await act(async () => root.render(PreviewHost, { url: address }));
	await vi.waitFor(
		async () => {
			await act(async () => undefined);
			expect(
				container.querySelector(
					'.app-shell:not([aria-busy]), .ui-view .ui-alert',
				),
			).not.toBeNull();
		},
		{ timeout: 5000 },
	);
	return container;
}

function navigation(container: HTMLElement): string[] {
	return [...container.querySelectorAll('a.nav-item')].map(
		(item) => item.getAttribute('href') ?? '',
	);
}

it('shows a draft module that depends on system.core and opens its screen', async () => {
	const container = await openPreview(`/preview/${SESSION}`);

	expect(navigation(container)).toEqual([
		'/app/preview',
		'/app/preview/equipment',
		'/app/preview/modules',
	]);
	expect(container.querySelector('.equipment-screen')).not.toBeNull();
	expect(window.location.pathname).toBe('/app/preview/equipment');
	expect(requested.filter((path) => path.endsWith('/preview'))).toHaveLength(1);
});

it('reopens the draft screen a reload inside the shell names', async () => {
	document.cookie = `flowdular_preview=${SESSION}; path=/`;
	const container = await openPreview('/app/preview/equipment');

	expect(navigation(container)).toContain('/app/preview/equipment');
	expect(container.querySelector('.equipment-screen')).not.toBeNull();
	expect(window.location.pathname).toBe('/app/preview/equipment');
});

it('names no session for a shell address without the preview cookie', async () => {
	const container = await openPreview('/app/preview/equipment');

	expect(container.querySelector('.ui-alert')?.textContent).toContain(
		'The preview session is unavailable.',
	);
	expect(container.querySelector('.app-shell')).toBeNull();
	expect(requested).toEqual([]);
});
