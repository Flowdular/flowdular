import { beforeAll, describe, expect, it } from 'vitest';
import { Button } from '../src/components/Button.tsrx';
import { PageHeader } from '../src/components/PageHeader.tsrx';
import { Icon } from '../src/icons/Icon.tsrx';
import { measureInChrome } from './chrome.ts';
import { mount } from './dom.ts';

interface Box {
	readonly left: number;
	readonly right: number;
	readonly top: number;
	readonly bottom: number;
}

interface HeaderLayout {
	readonly viewport: number;
	readonly page: number;
	readonly head: Box;
	readonly title: Box;
	readonly actions: readonly (Box & { readonly label: string })[];
}

const PHONE = 390;
const DESKTOP = 1280;

const MEASURE = `(() => {
	const box = (node) => {
		const { left, right, top, bottom } = node.getBoundingClientRect();
		return { left, right, top, bottom };
	};
	const head = document.querySelector('.ui-page-head');
	return {
		viewport: document.documentElement.clientWidth,
		page: document.documentElement.scrollWidth,
		head: box(head),
		title: box(head.firstElementChild),
		actions: [...head.querySelectorAll('button')].map((button) => ({
			label: button.textContent.trim(),
			...box(button),
		})),
	};
})()`;

/* A record screen's header with the five actions it can carry, in the
   workspace padding a phone gets (packages/client shell.css). */
async function recordHeaderPage(): Promise<string> {
	const mounted = await mount(
		<PageHeader
			eyebrow="Sprzedaż"
			title="Zlecenie ZL-2026-0142"
			description="Pozycje, terminy i historia zmian zlecenia."
		>
			<Button size="sm">
				<Icon name="chevron-left" size={14} />
				{'Wstecz'}
			</Button>
			<Button size="sm">
				<Icon name="refresh" size={14} />
				{'Odśwież'}
			</Button>
			<Button size="sm">{'Edytuj'}</Button>
			<Button size="sm">{'Archiwizuj'}</Button>
			<Button size="sm" variant="primary">
				<Icon name="plus" size={14} />
				{'Nowe zlecenie'}
			</Button>
		</PageHeader>,
	);
	const markup = mounted.container.innerHTML;
	mounted.unmount();
	const links = [
		'../node_modules/@fontsource-variable/ibm-plex-sans/index.css',
		'../src/styles/index.css',
	].map(
		(path) =>
			`<link rel="stylesheet" href="${new URL(path, import.meta.url).href}" />`,
	).join('\n');
	return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8" />
${links}
</head>
<body style="margin: 0; padding: 20px 16px">
<div class="ui-view">${markup}</div>
</body>
</html>`;
}

describe('PageHeader at phone and desktop widths', () => {
	let phone: HeaderLayout;
	let desktop: HeaderLayout;

	beforeAll(async () => {
		[phone, desktop] = await measureInChrome<HeaderLayout>(
			await recordHeaderPage(),
			[PHONE, DESKTOP],
			MEASURE,
		) as [HeaderLayout, HeaderLayout];
	}, 60_000);

	it('keeps five actions inside a 390 px viewport, under the title', () => {
		expect(phone.viewport).toBe(PHONE);
		expect(phone.page).toBeLessThanOrEqual(phone.viewport);
		expect(phone.actions).toHaveLength(5);
		for (const action of phone.actions) {
			expect(action.left, action.label).toBeGreaterThanOrEqual(phone.head.left);
			expect(action.right, action.label).toBeLessThanOrEqual(phone.head.right);
			expect(action.top, action.label).toBeGreaterThanOrEqual(
				phone.title.bottom,
			);
		}
	});

	it('wraps the actions in the order Tab and a screen reader meet them', () => {
		const seen = [...phone.actions].sort(
			(left, right) => left.top - right.top || left.left - right.left,
		).map((action) => action.label);
		expect(seen).toEqual(phone.actions.map((action) => action.label));
	});

	it('keeps the actions on one row beside the title on a desktop', () => {
		expect(desktop.page).toBeLessThanOrEqual(desktop.viewport);
		const rows = new Set(desktop.actions.map((action) => action.top));
		expect(rows.size).toBe(1);
		expect(desktop.actions[0]?.left).toBeGreaterThanOrEqual(
			desktop.title.right,
		);
		expect(desktop.actions.at(-1)?.right).toBe(desktop.head.right);
	});
});
