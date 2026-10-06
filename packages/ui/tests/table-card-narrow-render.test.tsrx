import { beforeAll, describe, expect, it } from 'vitest';
import { CellStack, CellTag, CellText } from '../src/components/cells.tsrx';
import type { TableColumn } from '../src/components/Table.tsrx';
import { TableCard } from '../src/components/TableCard.tsrx';
import { measureInChrome } from './chrome.ts';
import { mount } from './dom.ts';

interface Cell {
	readonly label: string;
	readonly left: number;
	readonly right: number;
}

interface Scrolled {
	readonly wrap: { readonly left: number; readonly right: number };
	readonly rows: readonly (readonly Cell[])[];
}

interface CardLayout {
	readonly scrolls: boolean;
	readonly position: string;
	readonly start: Scrolled;
	readonly end: Scrolled;
}

interface PageLayout {
	readonly viewport: number;
	readonly page: number;
	readonly cards: readonly CardLayout[];
}

interface Code {
	readonly id: string;
	readonly code: string;
	readonly url: string;
	readonly community: string;
	readonly label: string;
	readonly status: string;
}

const PHONE = 390;
const DESKTOP = 1280;

/* Every row's visible cells, with the wrapper scrolled to its start and to its
   end; the action column has no header text. */
const MEASURE = `(() => {
	const box = (node) => {
		const { left, right } = node.getBoundingClientRect();
		return { left, right };
	};
	const cards = [...document.querySelectorAll('.ui-card')].map((card) => {
		const wrap = card.querySelector('.ui-table-wrap');
		const headers = [...wrap.querySelectorAll('thead th')];
		const at = (scrollLeft) => {
			wrap.scrollLeft = scrollLeft;
			return {
				wrap: box(wrap),
				rows: [...wrap.querySelectorAll('tbody tr')].map((row) =>
					[...row.cells]
						.filter((cell) => getComputedStyle(cell).display !== 'none')
						.map((cell) => ({
							label: headers[cell.cellIndex].textContent.trim() || 'Actions',
							...box(cell),
						})),
				),
			};
		};
		const layout = {
			scrolls: wrap.scrollWidth > wrap.clientWidth,
			position: getComputedStyle(wrap.querySelector('td.ui-table__actions'))
				.position,
			start: at(0),
			end: at(wrap.scrollWidth),
		};
		wrap.scrollLeft = 0;
		return layout;
	});
	return {
		viewport: document.documentElement.clientWidth,
		page: document.documentElement.scrollWidth,
		cards,
	};
})()`;

const CODES: readonly Code[] = [
	{
		id: '1',
		code: 'WSP-7K2Q-9XMD',
		url: 'https://wspolnota.example/k/WSP-7K2Q-9XMD/rejestracja',
		community: 'osiedle-zielone-wzgorze',
		label: 'Klatka B',
		status: 'Aktywny',
	},
	{
		id: '2',
		code: 'WSP-3HV8-PL4C',
		url: 'https://wspolnota.example/k/WSP-3HV8-PL4C/rejestracja',
		community: 'kamienica-przy-parku',
		label: 'Brama od ulicy',
		status: 'Aktywny',
	},
];

/* The shape of a building codes list: a code over its URL, a mono code, a
   column that hides, a status, and one row action. */
const COLUMNS: readonly TableColumn<Code>[] = [
	{
		key: 'code',
		header: 'Kod',
		width: 'auto',
		cell: (row) =>
			<CellStack
				primary={row.code}
				primaryMono
				secondary={row.url}
				secondaryMono
			/>,
	},
	{
		key: 'community',
		header: 'Wspólnota',
		width: '160px',
		cell: (row) => <CellText value={row.community} mono />,
	},
	{
		key: 'label',
		header: 'Etykieta',
		width: '160px',
		priority: 2,
		cell: (row) => <CellText value={row.label} />,
	},
	{
		key: 'status',
		header: 'Status',
		width: '140px',
		cell: (row) => <CellTag tone="success" dot label={row.status} />,
	},
];

function codesCard() {
	return <TableCard
		title="Kody budynku"
		count="2 na stronie"
		columns={COLUMNS}
		rows={CODES}
		rowKey={(row) => row.id}
		empty={{ icon: 'key', title: 'Brak kodów' }}
		actionsLabel="Akcje"
		actions={() => [
			{
				id: 'revoke',
				label: 'Unieważnij',
				icon: 'x',
				tone: 'danger',
				onSelect: () => {},
			},
		]}
	/>;
}

/* The card in the workspace padding a phone gets (packages/client shell.css),
   and the same card in a 520 px slot, three times its action column. */
async function codesPage(): Promise<string> {
	const mounted = await mount(
		<>
			{codesCard()}
			<div
				style="width: 520px; max-width: 100%; margin-top: 16px"
			>{codesCard()}</div>
		</>,
	);
	const markup = mounted.container.innerHTML;
	mounted.unmount();
	const links = [
		'../node_modules/@fontsource-variable/ibm-plex-sans/index.css',
		'../node_modules/@fontsource/ibm-plex-mono/index.css',
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

function expectNoCellOver(scrolled: Scrolled): void {
	for (const row of scrolled.rows) {
		const cells = [...row].sort((left, right) => left.left - right.left);
		cells.slice(1).forEach((cell, index) => {
			expect(
				cell.left,
				`${cell.label} under ${cells[index]!.label}`,
			).toBeGreaterThanOrEqual(cells[index]!.right - 0.5);
		});
	}
}

function cell(scrolled: Scrolled, label: string): Cell {
	return scrolled.rows[0]!.find((entry) => entry.label === label)!;
}

describe('TableCard with one row action at phone and desktop widths', () => {
	let phone: PageLayout;
	let desktop: PageLayout;

	beforeAll(async () => {
		[phone, desktop] = await measureInChrome<PageLayout>(
			await codesPage(),
			[PHONE, DESKTOP],
			MEASURE,
		) as [PageLayout, PageLayout];
	}, 60_000);

	it('scrolls the table inside the card, never the page, at 390 px', () => {
		expect(phone.viewport).toBe(PHONE);
		expect(phone.page).toBeLessThanOrEqual(phone.viewport);
		for (const card of phone.cards) expect(card.scrolls).toBe(true);
	});

	it(
		'keeps the action cell from covering the code, URL or status at 390 px',
		() => {
			for (const card of phone.cards) {
				expectNoCellOver(card.start);
				expectNoCellOver(card.end);
				const code = cell(card.start, 'Kod');
				expect(code.left).toBeGreaterThanOrEqual(card.start.wrap.left);
				expect(code.right).toBeLessThanOrEqual(card.start.wrap.right);
				for (const label of ['Status', 'Actions']) {
					const reached = cell(card.end, label);
					expect(reached.left, label).toBeGreaterThanOrEqual(
						card.end.wrap.left,
					);
					expect(reached.right, label).toBeLessThanOrEqual(card.end.wrap.right);
				}
			}
		},
	);

	it(
		'keeps the action column pinned where the card is three times its width',
		() => {
			expect(desktop.page).toBeLessThanOrEqual(desktop.viewport);
			const [wide, slot] = desktop.cards as [CardLayout, CardLayout];
			expect(wide.scrolls).toBe(false);
			expect(wide.position).toBe('sticky');
			expectNoCellOver(wide.start);
			expect(slot.scrolls).toBe(true);
			expect(slot.position).toBe('sticky');
			expect(cell(slot.start, 'Actions').right).toBeCloseTo(
				slot.start.wrap.right,
				0,
			);
		},
	);
});
