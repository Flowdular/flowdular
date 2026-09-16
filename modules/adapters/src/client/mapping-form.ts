import type {
	AdapterMappingRule,
	AdapterTransform,
} from '../domain/registry.ts';

/** One editable rule of the drawer; every field is text while it is edited. */
export interface MappingDraft {
	readonly key: string;
	readonly to: string;
	readonly transform: AdapterTransform;
	readonly from: string;
	readonly value: string;
	/** One `source=target` pair per line. */
	readonly table: string;
}

let drafts = 0;

export function draftOf(rule: AdapterMappingRule | null): MappingDraft {
	drafts += 1;
	return {
		key: 'rule-' + drafts,
		to: rule?.to ?? '',
		transform: rule?.transform ?? 'rename',
		from: rule?.from ?? '',
		value: rule?.value ?? '',
		table: Object.entries(rule?.table ?? {})
			.map(([source, target]) => `${source}=${target}`)
			.join('\n'),
	};
}

/** The drafts as rules the server validates; blank rows are left out. */
export function rulesOf(
	entries: readonly MappingDraft[],
): readonly AdapterMappingRule[] {
	return entries
		.filter((entry) => entry.to.trim() !== '')
		.map((entry) => {
			const pairs: [string, string][] = [];
			for (const line of entry.table.split('\n')) {
				const separator = line.indexOf('=');
				if (separator <= 0) continue;
				pairs.push([
					line.slice(0, separator).trim(),
					line.slice(separator + 1).trim(),
				]);
			}
			const table = Object.fromEntries(pairs);
			return {
				to: entry.to.trim(),
				transform: entry.transform,
				...(entry.transform === 'constant' ? {} : { from: entry.from.trim() }),
				...(entry.value.trim() === '' ? {} : { value: entry.value.trim() }),
				...(entry.transform === 'lookup' ? { table } : {}),
			};
		});
}
