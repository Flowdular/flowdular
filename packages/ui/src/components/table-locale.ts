import { createContext } from 'octane';

/** The words and the locale every table and cell shares. The shell provides them; a screen never passes them. */
export interface TableLocale {
	/** BCP 47 locale for times and numbers; undefined reads the host locale. */
	readonly locale?: string | undefined;
	/** Accessible name of a collapsed row's expand button. */
	readonly expand: string;
	/** Accessible name of an expanded row's expand button. */
	readonly collapse: string;
	/** Accessible name of the menu button that holds a row's actions. */
	readonly moreActions: string;
	readonly copy: string;
	readonly copied: string;
}

export const DEFAULT_TABLE_LOCALE: TableLocale = {
	expand: 'Show details',
	collapse: 'Hide details',
	moreActions: 'More actions',
	copy: 'Copy',
	copied: 'Copied',
};

export const TableLocaleContext =
	createContext<TableLocale>(DEFAULT_TABLE_LOCALE);

/* False inside a clickable row's open button, where a nested control would be
   invalid markup and would steal the row's click. */
export const CellControlsContext = createContext<boolean>(true);
