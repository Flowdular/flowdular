import { useEffect, useMemo } from 'octane';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import { ApiError } from './api.ts';
import { ModuleSettingRow } from './ModuleSettingRow.tsrx';
import { loadSettings } from './settings-api.ts';
import { createSectionState, saveSetting } from './settings-state.ts';

export interface ModuleSettingsSectionProps {
	readonly moduleId: string;
	readonly csrfToken: string;
	readonly canManage: boolean;
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
					: t('system.settings.errorLoad'),
			);
			setStatus(denied ? 'denied' : 'error');
		}
	};

	useEffect(() => {
		void refresh();
	}, [props.moduleId]);

	<div class="ui-form__section">
		<div class="ui-form__section-head">
			<b>{t('system.settings.title')}</b>
			<small>{t('system.settings.description')}</small>
		</div>
		@if (status === 'denied') {
			<span class="ui-help">{t('system.settings.deniedRead')}</span>
		} @else if (status === 'error') {
			<span class="ui-help ui-help--error">{error}</span>
		} @else if (status === 'loading') {
			<span class="ui-help">{t('system.settings.loading')}</span>
		} @else if (settings.length === 0) {
			<span class="ui-help">{t('system.settings.empty')}</span>
		} @else {
			<>
				@if (!props.canManage) {
					<span class="ui-help">{t('system.settings.deniedManage')}</span>
				}
				<div>
					@for (const setting of settings; key setting.key) {
						<ModuleSettingRow
							setting={setting}
							canManage={props.canManage}
							busy={busyKey === setting.key}
							showScope={true}
							result={results.get(setting.key) ?? null}
							onSave={(value) => void saveSetting(
								client,
								props.moduleId,
								setting.key,
								value,
								props.csrfToken,
							)}
						/>
					}
				</div>
			</>
		}
	</div>
}
