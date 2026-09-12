import { useEffect, useMemo } from 'octane';
import { Alert, EmptyState, Icon } from '@flowdular/ui';
import { t, workspaceViewHref } from '@flowdular/client';
import { useValue } from 'segment-state';
import { ApiError } from './api.ts';
import { flagCount, flagGroups } from './flags.ts';
import { ModuleSettingRow } from './ModuleSettingRow.tsrx';
import { AUDIT_VIEW_ID, FLAG_AUDIT_ACTION } from './navigation.ts';
import { loadSettings } from './settings-api.ts';
import { createFlagsState, rowKey, saveFlag } from './settings-state.ts';

export interface FlagsPanelProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

/*
 * Every declared feature flag in the workspace, grouped by the module that
 * owns it. Flags are read from the settings listing rather than a list of
 * their own: a flag is a module setting, so the screen costs the one request
 * the Settings section already makes and no module gains a second write path.
 */
export function FlagsPanel(props: FlagsPanelProps) @{
	const client = useMemo(() => createFlagsState(), []);
	const [groups] = useValue(client.state.groups);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [busyKey] = useValue(client.state.busyKey);
	const [results] = useValue(client.state.results);
	const auditHref = workspaceViewHref(AUDIT_VIEW_ID);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const next = flagGroups(await loadSettings());
			client.store.act((transaction) => {
				transaction.set(client.state.groups, next);
				transaction.set(client.state.status, 'idle');
				transaction.set(client.state.busyKey, null);
				transaction.set(client.state.results, new Map());
			}, 'system/flags-loaded');
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
	}, []);

	@if (status === 'denied') {
		<section class="ui-card">
			<EmptyState icon="shield" title={t('system.flags.deniedTitle')}>{t(
				'system.flags.deniedHint',
			)}</EmptyState>
		</section>
	} @else if (status === 'error') {
		<Alert>{error}</Alert>
	} @else if (status === 'loading') {
		<section class="ui-card">
			<EmptyState icon="modules" title={t('system.flags.loading')}>{t(
				'system.flags.loadingHint',
			)}</EmptyState>
		</section>
	} @else if (groups.length === 0) {
		<section class="ui-card">
			<EmptyState icon="modules" title={t('system.flags.emptyTitle')}>{t(
				'system.flags.emptyHint',
			)}</EmptyState>
		</section>
	} @else {
		<section class="ui-card">
			<div class="ui-card__head">
				<span class="ui-card__title">
					{t('system.flags.title')}
					<small>{t('system.flags.count', {
						count: flagCount(groups),
						modules: groups.length,
					})}</small>
				</span>
			</div>
			@if (!props.canManage) {
				<p class="ui-note">
					<Icon name="shield" size={14} />
					{t('system.flags.deniedManage')}
				</p>
			}
			@for (const group of groups; key group.moduleId) {
				<div class="ui-form__section">
					<div class="ui-form__section-head">
						<b>{group.name}</b>
						<small class="ui-mono">{group.moduleId}</small>
					</div>
					@for (const flag of group.flags; key flag.key) {
						<ModuleSettingRow
							setting={flag}
							canManage={props.canManage}
							busy={busyKey === rowKey(group.moduleId, flag.key)}
							showScope={true}
							result={results.get(rowKey(group.moduleId, flag.key)) ?? null}
							onSave={(value) => void saveFlag(
								client,
								group.moduleId,
								flag.key,
								value,
								props.csrfToken,
							)}
						/>
					}
				</div>
			}
			<p class="ui-note">
				<Icon name="activity" size={14} />
				{t('system.flags.auditNote', { action: FLAG_AUDIT_ACTION })}
				{' '}
				<a href={auditHref}>{t('system.flags.auditLink')}</a>
			</p>
		</section>
	}
}
