// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
	ACTIONS_FOLDED_WIDTH,
	actionsFold,
	FLEXIBLE_MIN,
	FLEXIBLE_READING,
	hideOrder,
	SELECT_WIDTH,
	TABLE_STEP,
	TABLE_STEP_MAX,
	TABLE_STEP_MIN,
	tableLayout,
	tableStep,
	TOGGLE_WIDTH,
	type TableLayoutColumn,
} from '../src/components/table-layout.ts';
import { tableStepsCss } from '../src/components/table-steps.ts';

function stepOf(classes: readonly string[], kind: string): number | undefined {
	const match = classes
		.map((name) => new RegExp('^ui-table--' + kind + '-(\\d+)$').exec(name))
		.find((found) => found !== null);
	return match ? Number(match[1]) : undefined;
}

function px(column: TableLayoutColumn, flexible: number): number {
	const found = /^(\d+)px$/.exec(column.width ?? '');
	return found ? Number(found[1]) : flexible;
}

function width(
	columns: readonly TableLayoutColumn[],
	indexes: readonly number[],
	flexible: number,
): number {
	return indexes.reduce(
		(total, index) => total + px(columns[index]!, flexible),
		0,
	);
}

const MODULES: readonly TableLayoutColumn[] = [
	{ width: 'auto', priority: 1 },
	{ width: '120px', priority: 2 },
	{ width: '200px', priority: 3 },
	{ width: '140px', priority: 3 },
	{ width: '170px', priority: 2 },
	{ width: '130px', priority: 1 },
];

describe('table steps', () => {
	it('rounds up to the next step and stays inside the generated range', () => {
		expect(tableStep(1126)).toBe(1160);
		expect(tableStep(1160)).toBe(1160);
		expect(tableStep(10)).toBe(TABLE_STEP_MIN);
		expect(tableStep(9000)).toBe(TABLE_STEP_MAX);
	});

	it('has one container query per step in table-steps.css', async () => {
		/* The package carries no Node types, and a CSS import reads as empty
	   under vitest, so the file is read through a specifier TS does not resolve. */
		const fs: { readFileSync(path: URL, encoding: 'utf8'): string } =
			await import('node:' + 'fs');
		const file = fs.readFileSync(
			new URL('../src/styles/table-steps.css', import.meta.url),
			'utf8',
		);
		const normalize = (css: string) => css.replace(/\s+/g, ' ').trim();
		expect(normalize(file)).toBe(normalize(tableStepsCss()));
		for (
			let step = TABLE_STEP_MIN;
			step <= TABLE_STEP_MAX;
			step += TABLE_STEP
		) {
			expect(file).toContain(`@container (width < ${step}px)`);
			expect(file).toContain(`.ui-table .ui-table__hide-${step} {`);
			expect(file).toContain(`.ui-table .ui-table__reveal-${step} {`);
			expect(file).toContain(`.ui-table--fold-${step} {`);
		}
	});
});

describe('tableLayout', () => {
	it('hides nothing and scrolls only below every column at its narrowest', () => {
		const layout = tableLayout({
			columns: [
				{ width: '50%', priority: 1 },
				{ width: '25%', priority: 1 },
				{ width: '25%', priority: 1 },
			],
			selection: false,
			actionsWidth: undefined,
			fold: 'never',
		});
		expect(layout.classes).toEqual([]);
		expect(layout.hideSteps).toEqual([undefined, undefined, undefined]);
		expect(layout.revealStep).toBeUndefined();
		expect(layout.collapsible).toBe(false);
		expect(layout.minWidth).toBe(3 * FLEXIBLE_MIN);
	});

	it('counts only the columns that never hide, the selection and the folded actions in the minimum', () => {
		const layout = tableLayout({
			columns: MODULES,
			selection: true,
			actionsWidth: '236px',
			fold: 'narrow',
		});
		expect(layout.collapsible).toBe(true);
		expect(layout.minWidth).toBe(
			FLEXIBLE_MIN + 130 + SELECT_WIDTH + TOGGLE_WIDTH + ACTIONS_FOLDED_WIDTH,
		);
		expect(layout.actionsWidth).toBe(236);
	});

	it('hides priority 3 before 2 and the last declared first', () => {
		expect(hideOrder(MODULES)).toEqual([3, 2, 4, 1]);
		expect(
			hideOrder([
				{ width: 'auto', priority: 3 },
				{ width: '80px', priority: 1 },
			]),
		).toEqual([]);
	});

	it('hides one column at a time, each once the columns beside it stop fitting', () => {
		const layout = tableLayout({
			columns: MODULES,
			selection: false,
			actionsWidth: '236px',
			fold: 'narrow',
		});
		const order = hideOrder(MODULES);
		let visible = [0, 1, 2, 3, 4, 5];
		order.forEach((index, position) => {
			const needed =
				width(MODULES, visible, FLEXIBLE_READING) +
				236 +
				(position === 0 ? 0 : TOGGLE_WIDTH);
			const step = layout.hideSteps[index] ?? 0;
			expect(step).toBeGreaterThanOrEqual(needed);
			expect(step - TABLE_STEP).toBeLessThan(needed);
			visible = visible.filter((kept) => kept !== index);
		});
		const steps = order.map((index) => layout.hideSteps[index] ?? 0);
		expect([...steps].sort((a, b) => b - a)).toEqual(steps);
		expect(new Set(steps).size).toBe(steps.length);
		expect(layout.revealStep).toBe(steps[0]);
		expect(layout.hideSteps[0]).toBeUndefined();
		expect(layout.hideSteps[5]).toBeUndefined();
		const fold = stepOf(layout.classes, 'fold') ?? 0;
		expect(fold).toBeGreaterThanOrEqual(3 * 236);
		expect(fold).toBeGreaterThanOrEqual(
			FLEXIBLE_MIN + 130 + TOGGLE_WIDTH + 236,
		);
	});

	it('keeps Version in a 904 pixel Modules card, where hiding a whole priority dropped it', () => {
		const layout = tableLayout({
			columns: MODULES,
			selection: false,
			actionsWidth: '236px',
			fold: 'narrow',
		});
		const shown = MODULES.map((_, index) => index).filter(
			(index) => (layout.hideSteps[index] ?? 0) <= 904,
		);
		expect(shown).toEqual([0, 1, 5]);
	});

	it('gives a table that always folds the narrow action column everywhere', () => {
		const layout = tableLayout({
			columns: [
				{ width: 'auto', priority: 1 },
				{ width: '160px', priority: 3 },
			],
			selection: false,
			actionsWidth: '320px',
			fold: 'always',
		});
		expect(layout.actionsWidth).toBe(ACTIONS_FOLDED_WIDTH);
		expect(stepOf(layout.classes, 'fold')).toBeUndefined();
		expect(layout.hideSteps).toEqual([
			undefined,
			tableStep(FLEXIBLE_READING + 160 + ACTIONS_FOLDED_WIDTH),
		]);
	});

	it('folds only when a row has two actions or more', () => {
		expect(actionsFold(0)).toBe('never');
		expect(actionsFold(1)).toBe('never');
		expect(actionsFold(2)).toBe('narrow');
		expect(actionsFold(3)).toBe('always');
	});
});
