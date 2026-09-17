/** 1 always shows; 2 hides in a narrow table; 3 hides first. */
export type TablePriority = 1 | 2 | 3;

/** How the row actions render: as buttons, as a More menu below the fold width, or always as a menu. */
export type TableActionsFold = 'never' | 'narrow' | 'always';

/* The container widths a table can hide or fold at. `table-steps.css` holds one
   container query per step and is generated from these numbers by
   `scripts/gen-table-steps.mjs`; a test keeps the two in step. */
export const TABLE_STEP = 40;
export const TABLE_STEP_MIN = 480;
export const TABLE_STEP_MAX = 1600;

export const SELECT_WIDTH = 44;
export const TOGGLE_WIDTH = 28;
export const ACTIONS_WIDTH = 160;
export const ACTIONS_FOLDED_WIDTH = 64;
/** The narrowest a flexible (auto or percentage) column gets before the table scrolls. */
export const FLEXIBLE_MIN = 120;
/** The width a flexible column is given while deciding whether a lower priority still fits beside it. */
export const FLEXIBLE_READING = 200;

export interface TableLayoutColumn {
	readonly width: string | undefined;
	readonly priority: TablePriority;
}

export interface TableLayoutInput {
	readonly columns: readonly TableLayoutColumn[];
	readonly selection: boolean;
	/** Declared width of the action column, or undefined when the table has no actions. */
	readonly actionsWidth: string | undefined;
	readonly fold: TableActionsFold;
}

export interface TableLayout {
	/** Fold step class on the table: `ui-table--fold-<px>`. */
	readonly classes: readonly string[];
	/** Per column, the container step below which it hides (`ui-table__hide-<px>`), or undefined when it never hides. */
	readonly hideSteps: readonly (number | undefined)[];
	/** The step below which some column is hidden, so the expand button and the details list show; undefined when nothing hides. */
	readonly revealStep: number | undefined;
	/** The width below which even the priority 1 columns no longer fit and the wrapper scrolls. */
	readonly minWidth: number;
	/** Some column can hide, so rows carry the expand button. */
	readonly collapsible: boolean;
	/** Width of the action column while its buttons are visible. */
	readonly actionsWidth: number;
}

export function columnPx(width: string | undefined, flexible: number): number {
	const px = /^(\d+(?:\.\d+)?)px$/.exec(width?.trim() ?? '');
	return px ? Number(px[1]) : flexible;
}

/** The step at or above `width`, so a table hides a little early rather than a little late. */
export function tableStep(width: number): number {
	const step = Math.ceil(width / TABLE_STEP) * TABLE_STEP;
	return Math.min(TABLE_STEP_MAX, Math.max(TABLE_STEP_MIN, step));
}

/** Indexes of the columns that can hide, in the order they hide: priority 3 before 2, the last declared first. The first column never hides. */
export function hideOrder(columns: readonly TableLayoutColumn[]): number[] {
	return columns
		.map((column, index) => ({ index, priority: column.priority }))
		.filter((column) => column.index > 0 && column.priority > 1)
		.sort((a, b) => b.priority - a.priority || b.index - a.index)
		.map((column) => column.index);
}

/**
 * Where each column hides and where the actions fold, from the declared widths
 * alone. Columns hide one at a time: a column hides once the container is
 * narrower than it and every column still beside it at a reading width, so the
 * table hides before it scrolls; it scrolls only below `minWidth`, when the
 * columns that never hide no longer fit at their narrowest.
 */
export function tableLayout(input: TableLayoutInput): TableLayout {
	const columns = input.columns;
	const order = hideOrder(columns);
	const collapsible = order.length > 0;
	const select = input.selection ? SELECT_WIDTH : 0;
	const toggle = collapsible ? TOGGLE_WIDTH : 0;
	const hasActions = input.actionsWidth !== undefined;
	const actions = hasActions ? columnPx(input.actionsWidth, ACTIONS_WIDTH) : 0;
	const open = !hasActions
		? 0
		: input.fold === 'always'
			? ACTIONS_FOLDED_WIDTH
			: actions;
	const hideSteps: (number | undefined)[] = columns.map(() => undefined);
	let visible = select + open;
	for (const column of columns)
		visible += columnPx(column.width, FLEXIBLE_READING);
	let previous = Number.POSITIVE_INFINITY;
	order.forEach((index, position) => {
		/* The expand button appears with the first hidden column, so every later
		   step counts it. Steps never rise, so a wider container hides no more. */
		const step = Math.min(
			previous,
			tableStep(visible + (position === 0 ? 0 : toggle)),
		);
		hideSteps[index] = step;
		previous = step;
		visible -= columnPx(columns[index]!.width, FLEXIBLE_READING);
	});
	let narrowest = select + toggle;
	columns.forEach((column, index) => {
		if (hideSteps[index] === undefined)
			narrowest += columnPx(column.width, FLEXIBLE_MIN);
	});
	const classes: string[] = [];
	if (hasActions && input.fold === 'narrow')
		classes.push(
			'ui-table--fold-' + tableStep(Math.max(3 * actions, narrowest + actions)),
		);
	return {
		classes,
		hideSteps,
		revealStep: collapsible ? hideSteps[order[0]!] : undefined,
		minWidth: Math.ceil(
			narrowest +
				(!hasActions
					? 0
					: input.fold === 'never'
						? actions
						: ACTIONS_FOLDED_WIDTH),
		),
		collapsible,
		actionsWidth: open,
	};
}

/** Two actions fit as buttons until the table is narrow; more than two always fold. */
export function actionsFold(most: number): TableActionsFold {
	if (most > 2) return 'always';
	return most === 2 ? 'narrow' : 'never';
}
