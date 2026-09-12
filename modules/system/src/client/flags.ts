import type {
	SettingsEntryPayload,
	SettingsModulePayload,
} from './settings-api.ts';

export interface FlagGroup {
	readonly moduleId: string;
	readonly name: string;
	readonly flags: readonly SettingsEntryPayload[];
}

/**
 * The flags the Flags screen shows, grouped by the module that declares them.
 * A flag is a module setting, so the screen reads the settings listing and
 * keeps only the entries the kernel marked `kind: 'flag'`; a module without one
 * drops out rather than showing an empty group. Order follows the listing, so
 * two reads of the same workspace render the same screen.
 */
export function flagGroups(
	modules: readonly SettingsModulePayload[],
): readonly FlagGroup[] {
	const groups: FlagGroup[] = [];
	for (const module of modules) {
		const flags = module.settings.filter((setting) => setting.kind === 'flag');
		if (flags.length === 0) continue;
		groups.push({ moduleId: module.moduleId, name: module.name, flags });
	}
	return groups;
}

export function flagCount(groups: readonly FlagGroup[]): number {
	let total = 0;
	for (const group of groups) total += group.flags.length;
	return total;
}
