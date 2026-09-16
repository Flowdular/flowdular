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
	/** Step classes on the table: `ui-table--p3-<px>`, `ui-table--p2-<px>`, `ui-table--fold-<px>`. */
	readonly classes: readonly string[];
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

function sum(
	columns: readonly TableLayoutColumn[],
	most: TablePriority,
	flexible: number,
): number {
	let total = 0;
	for (const column of columns)
		if (column.priority <= most) total += columnPx(column.width, flexible);
	return total;
}

/**
 * Where each priority hides and where the actions fold, from the declared
 * widths alone. A priority hides once the container is narrower than the
 * columns that would stay beside it at a reading width, so the table hides
 * before it scrolls; it scrolls only below `minWidth`, when the priority 1
 * columns at their narrowest no longer fit.
 */
export function tableLayout(input: TableLayoutInput): TableLayout {
	const columns = input.columns;
	const hasP2 = columns.some((column) => column.priority === 2);
	const hasP3 = columns.some((column) => column.priority === 3);
	const collapsible = hasP2 || hasP3;
	const select = input.selection ? SELECT_WIDTH : 0;
	const toggle = collapsible ? TOGGLE_WIDTH : 0;
	const hasActions = input.actionsWidth !== undefined;
	const actions = hasActions ? columnPx(input.actionsWidth, ACTIONS_WIDTH) : 0;
	const open = !hasActions
		? 0
		: input.fold === 'always'
			? ACTIONS_FOLDED_WIDTH
			: actions;
	const classes: string[] = [];
	if (hasP3)
		classes.push(
			'ui-table--p3-' +
				tableStep(sum(columns, 3, FLEXIBLE_READING) + select + open),
		);
	if (hasP2)
		classes.push(
			'ui-table--p2-' +
				tableStep(sum(columns, 2, FLEXIBLE_READING) + select + open + toggle),
		);
	const narrowest = sum(columns, 1, FLEXIBLE_MIN) + select + toggle;
	if (hasActions && input.fold === 'narrow')
		classes.push(
			'ui-table--fold-' + tableStep(Math.max(3 * actions, narrowest + actions)),
		);
	return {
		classes,
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
