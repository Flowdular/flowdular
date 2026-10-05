import { Head } from '@octanejs/seo';
import { act, createRoot, setIsOctaneActEnvironment, useMemo } from 'octane';
import { afterEach, expect, it } from 'vitest';
import {
	ApplicationShell,
	COMMAND_SEARCH_DEBOUNCE_MS,
	openCommandPalette,
	type ModuleClientContribution,
} from '../src/index.ts';

setIsOctaneActEnvironment(true);

/* A module screen that keeps the open record in its query string and reads it
   once, on mount. A list row links to a record relative to the open address. */
function RecordsView() @{
	const address = useMemo(
		() => window.location.search + window.location.hash,
		[],
	);
	@if (address === '') {
		<a class="records-row" href="?id=9">Record 9</a>
	} @else {
		<p class="records-record">{address}</p>
	}
}

const RECORDS: ModuleClientContribution = {
	moduleId: 'records.core',
	navigation: [
		{
			id: 'records.navigation',
			viewId: 'records',
			group: 'Operations',
			label: 'Records',
			glyph: 'catalog',
			description: 'Records',
			scope: 'records.read',
			order: 10,
		},
		{
			id: 'records.navigation.inbox',
			viewId: 'inbox',
			group: 'Operations',
			label: 'Inbox',
			glyph: 'inbox',
			description: 'Inbox',
			scope: 'records.read',
			order: 20,
		},
	],
	views: [
		{ id: 'records', render: () => <RecordsView /> },
		{
			id: 'inbox',
			render: () =>
				<a class="inbox-link" href="/app/acme/records?id=7#notes">Record 7</a>,
		},
	],
	commandSearch: {
		id: 'records.search',
		scope: 'records.read',
		order: 10,
		search: async () => [
			{
				id: 'record-42',
				provider: 'records',
				providerLabel: 'Records',
				title: 'Record 42',
				snippet: '',
				viewId: 'records',
				route: '/records?id=42',
			},
		],
	},
};

const IDENTITY = {
	accountId: 'account-1',
	email: 'owner@acme.test',
	displayName: 'Owner',
	role: 'owner',
	scopes: ['system.workspace.access', 'records.read'],
	tenantId: 'tenant-1',
	tenants: [
		{ tenantId: 'tenant-1', name: 'Acme', slug: 'acme', role: 'owner' },
	],
};

let teardown: (() => void) | undefined;

afterEach(() => {
	teardown?.();
	teardown = undefined;
});

async function renderShell(address: string, initialView: string) {
	history.replaceState(null, '', address);
	const container = document.createElement('div');
	document.body.append(container);
	const root = createRoot(container);
	teardown = () => {
		root.unmount();
		container.remove();
	};
	await act(async () => {
		root.render(
			<Head>
				<ApplicationShell
					initialView={initialView}
					contributions={[RECORDS]}
					identity={IDENTITY}
					loadActiveModules={async () => null}
					onSignOut={() => {}}
					onSwitchTenant={() => {}}
				/>
			</Head>,
		);
	});
	return container;
}

async function click(element: Element | null): Promise<void> {
	expect(element).not.toBeNull();
	await act(async () => (element as HTMLElement).click());
}

function navigationEntry(container: HTMLElement, href: string): Element | null {
	return container.querySelector('a.nav-item[href="' + href + '"]');
}

function screen(container: HTMLElement): string {
	return container.querySelector('.records-record')?.textContent ??
		(container.querySelector('.records-row') ? 'list' : '');
}

async function traverse(step: () => void): Promise<void> {
	await act(async () => {
		const popped = new Promise((resolve) => window.addEventListener(
			'popstate',
			resolve,
			{ once: true },
		));
		step();
		await popped;
	});
}

it(
	'returns the open view to its list when its own entry is clicked',
	async () => {
		const container = await renderShell('/app/acme/records?id=123', 'records');
		expect(screen(container)).toBe('?id=123');

		await click(navigationEntry(container, '/app/acme/records'));

		expect(window.location.pathname + window.location.search).toBe(
			'/app/acme/records',
		);
		expect(screen(container)).toBe('list');
	},
);

it('keeps the query string and hash of an in-workspace link', async () => {
	const container = await renderShell('/app/acme/inbox', 'inbox');

	await click(container.querySelector('.inbox-link'));

	expect(window.location.pathname).toBe('/app/acme/records');
	expect(window.location.search).toBe('?id=7');
	expect(window.location.hash).toBe('#notes');
	expect(screen(container)).toBe('?id=7#notes');

	await click(navigationEntry(container, '/app/acme/records'));
	await click(container.querySelector('.records-row'));

	expect(window.location.pathname + window.location.search).toBe(
		'/app/acme/records?id=9',
	);
	expect(screen(container)).toBe('?id=9');
});

it('steps back and forward through records of the open view', async () => {
	const container = await renderShell('/app/acme/records?id=123', 'records');
	await click(navigationEntry(container, '/app/acme/records'));
	expect(screen(container)).toBe('list');

	await traverse(() => history.back());
	expect(window.location.search).toBe('?id=123');
	expect(screen(container)).toBe('?id=123');

	await traverse(() => history.forward());
	expect(window.location.search).toBe('');
	expect(screen(container)).toBe('list');

	await click(navigationEntry(container, '/app/acme/inbox'));
	expect(container.querySelector('.inbox-link')).not.toBeNull();

	await traverse(() => history.back());
	expect(window.location.pathname).toBe('/app/acme/records');
	expect(screen(container)).toBe('list');
});

it('opens a palette hit in the view that is already open', async () => {
	const container = await renderShell('/app/acme/records?id=123', 'records');
	await act(async () => openCommandPalette('record'));
	await act(async () => {
		await new Promise((resolve) => setTimeout(
			resolve,
			COMMAND_SEARCH_DEBOUNCE_MS + 50,
		));
	});

	await click(
		[...document.querySelectorAll('button.command-item')].find(
			(button) => button.textContent?.includes('Record 42'),
		) ?? null,
	);

	expect(window.location.pathname + window.location.search).toBe(
		'/app/acme/records?id=42',
	);
	expect(screen(container)).toBe('?id=42');
});
