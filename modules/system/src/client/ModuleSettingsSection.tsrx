import { useEffect, useMemo } from 'octane';
import type { ModuleSettingValue } from '@coreloom/kernel';
import { cell, createStore, useValue } from 'segment-state';
import { ApiError } from './api.ts';
import { ModuleSettingRow } from './ModuleSettingRow.tsrx';
import {
	loadSettings,
	updateSetting,
	type SettingsEntryPayload,
} from './settings-api.ts';

export interface ModuleSettingsSectionProps {
	readonly moduleId: string;
	readonly csrfToken: string;
	readonly canManage: boolean;
}

interface RowResult {
	readonly ok: boolean;
	readonly message: string;
}

type SectionStatus = 'loading' | 'idle' | 'denied' | 'error';

function createSectionState() {
	const store = createStore({
		settings: cell<readonly SettingsEntryPayload[]>([]),
		status: cell<SectionStatus>('loading'),
		error: '',
		busyKey: cell<string | null>(null),
		results: cell<ReadonlyMap<string, RowResult>>(new Map()),
	});
	return { store, state: store.state };
}

/* The Settings section of the Modules drawer: the selected module's declared
   settings with their tenant values, edited row by row. The server stays
   authoritative for both scopes; canManage only disables the controls. */
export function ModuleSettingsSection(props: ModuleSettingsSectionProps) @{
	const client = useMemo(() => createSectionState(), []);
	const [settings] = useValue(client.state.settings);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [busyKey] = useValue(client.state.busyKey);
	const [results] = useValue(client.state.results);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const modules = await loadSettings();
			const match = modules.find(
				(module) => module.moduleId === props.moduleId,
			);
			client.store.act((transaction) => {
				transaction.set(client.state.settings, match?.settings ?? []);
				transaction.set(client.state.status, 'idle');
				transaction.set(client.state.busyKey, null);
				transaction.set(client.state.results, new Map());
			}, 'system/module-settings-loaded');
		} catch (loadError) {
			const denied = loadError instanceof ApiError && loadError.status === 403;
			setError(
				loadError instanceof Error
					? loadError.message
					: 'Could not load settings.',
			);
			setStatus(denied ? 'denied' : 'error');
		}
	};

	useEffect(() => {
		void refresh();
	}, [props.moduleId]);

	const save = async (key: string, value: ModuleSettingValue | null) => {
		client.store.act((transaction) => {
			transaction.set(client.state.busyKey, key);
		}, 'system/module-setting-saving');
		try {
			const updated = await updateSetting(
				props.moduleId,
				key,
				value,
				props.csrfToken,
			);
			client.store.act((transaction) => {
				transaction.set(
					client.state.settings,
					settings.map(
						(setting) => setting.key === key && updated ? updated : setting,
					),
				);
				transaction.set(
					client.state.results,
					new Map(results).set(key, {
						ok: true,
						message: value === null ? 'Reset to default.' : 'Saved.',
					}),
				);
				transaction.set(client.state.busyKey, null);
			}, 'system/module-setting-saved');
		} catch (saveError) {
			client.store.act((transaction) => {
				transaction.set(
					client.state.results,
					new Map(results).set(key, {
						ok: false,
						message: saveError instanceof Error
							? saveError.message
							: 'Could not save the setting.',
					}),
				);
				transaction.set(client.state.busyKey, null);
			}, 'system/module-setting-save-failed');
		}
	};

	<div class="ui-form__section">
		<div class="ui-form__section-head">
			<b>Settings</b>
			<small>Declared by this module; a change applies at the next read.</small>
		</div>
		@if (status === 'denied') {
			<span class="ui-help">
				Reading settings needs the system.settings.read scope.
			</span>
		} @else if (status === 'error') {
			<span class="ui-help ui-help--error">{error}</span>
		} @else if (status === 'loading') {
			<span class="ui-help">Loading settings…</span>
		} @else if (settings.length === 0) {
			<span class="ui-help">This module declares no settings.</span>
		} @else {
			<>
				@if (!props.canManage) {
					<span class="ui-help">
						Changing settings needs the system.settings.manage scope.
					</span>
				}
				<div>
					@for (const setting of settings; key setting.key) {
						<ModuleSettingRow
							setting={setting}
							canManage={props.canManage}
							busy={busyKey === setting.key}
							showScope={true}
							result={results.get(setting.key) ?? null}
							onSave={(value) => void save(setting.key, value)}
						/>
					}
				</div>
			</>
		}
	</div>
}
