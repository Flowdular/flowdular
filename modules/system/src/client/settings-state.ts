import type { ModuleSettingValue } from '@flowdular/kernel';
import { t } from '@flowdular/client/i18n';
import { cell, createStore } from 'segment-state';
import type { FlagGroup } from './flags.ts';
import { updateSetting, type SettingsEntryPayload } from './settings-api.ts';

export interface RowResult {
	readonly ok: boolean;
	readonly message: string;
}

export type SettingsStatus = 'loading' | 'idle' | 'denied' | 'error';

/** Row identity across modules; a key alone repeats between them. */
export function rowKey(moduleId: string, key: string): string {
	return moduleId + '.' + key;
}

export function createFlagsState() {
	const store = createStore({
		groups: cell<readonly FlagGroup[]>([]),
		status: cell<SettingsStatus>('loading'),
		error: '',
		busyKey: cell<string | null>(null),
		results: cell<ReadonlyMap<string, RowResult>>(new Map()),
	});
	return { store, state: store.state };
}

export function createSectionState() {
	const store = createStore({
		settings: cell<readonly SettingsEntryPayload[]>([]),
		status: cell<SettingsStatus>('loading'),
		error: '',
		busyKey: cell<string | null>(null),
		results: cell<ReadonlyMap<string, RowResult>>(new Map()),
	});
	return { store, state: store.state };
}

export type FlagsState = ReturnType<typeof createFlagsState>;
export type SectionState = ReturnType<typeof createSectionState>;

interface SaveOutcome {
	/** The row the server answered with, or null when nothing was written. */
	readonly saved: SettingsEntryPayload | null;
	readonly result: RowResult;
}

async function settingSaved(
	moduleId: string,
	key: string,
	value: ModuleSettingValue | null,
	csrfToken: string,
): Promise<SaveOutcome> {
	try {
		return {
			saved: await updateSetting(moduleId, key, value, csrfToken),
			result: {
				ok: true,
				message:
					value === null
						? t('system.settings.resetDone')
						: t('system.settings.saved'),
			},
		};
	} catch (error) {
		return {
			saved: null,
			result: {
				ok: false,
				message:
					error instanceof Error
						? error.message
						: t('system.settings.errorSave'),
			},
		};
	}
}

/**
 * One row of a workspace's feature flags, written back when its request
 * answers. A second row can be saved while this one is still in flight, so
 * every cell is read inside the transaction: the values the render captured are
 * already behind by the time the answer arrives, and writing them back would
 * undo the save that landed first.
 */
export async function saveFlag(
	client: FlagsState,
	moduleId: string,
	key: string,
	value: ModuleSettingValue | null,
	csrfToken: string,
): Promise<void> {
	const identity = rowKey(moduleId, key);
	client.store.act((transaction) => {
		transaction.set(client.state.busyKey, identity);
	}, 'system/flag-saving');
	const { saved, result } = await settingSaved(moduleId, key, value, csrfToken);
	client.store.act(
		(transaction) => {
			if (saved) {
				transaction.update(client.state.groups, (current) =>
					current.map((group) =>
						group.moduleId !== moduleId
							? group
							: {
									...group,
									flags: group.flags.map((flag) =>
										flag.key === key ? saved : flag,
									),
								},
					),
				);
			}
			transaction.update(client.state.results, (current) =>
				new Map(current).set(identity, result),
			);
			/* A row still saving owns the indicator; only the row that finished
		   clears it. */
			transaction.update(client.state.busyKey, (current) =>
				current === identity ? null : current,
			);
		},
		result.ok ? 'system/flag-saved' : 'system/flag-save-failed',
	);
}

/** One row of a module's settings. Same in-flight rules as `saveFlag`. */
export async function saveSetting(
	client: SectionState,
	moduleId: string,
	key: string,
	value: ModuleSettingValue | null,
	csrfToken: string,
): Promise<void> {
	client.store.act((transaction) => {
		transaction.set(client.state.busyKey, key);
	}, 'system/module-setting-saving');
	const { saved, result } = await settingSaved(moduleId, key, value, csrfToken);
	client.store.act(
		(transaction) => {
			if (saved) {
				transaction.update(client.state.settings, (current) =>
					current.map((setting) => (setting.key === key ? saved : setting)),
				);
			}
			transaction.update(client.state.results, (current) =>
				new Map(current).set(key, result),
			);
			transaction.update(client.state.busyKey, (current) =>
				current === key ? null : current,
			);
		},
		result.ok
			? 'system/module-setting-saved'
			: 'system/module-setting-save-failed',
	);
}
