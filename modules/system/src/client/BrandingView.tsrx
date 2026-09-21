import { useEffect, useMemo } from 'octane';
import {
	brandingTitleSuffix,
	BRANDING_MODULE_ID,
	type ApplicationBranding,
} from '@flowdular/contracts';
import {
	Alert,
	BrandMark,
	Button,
	EmptyState,
	Icon,
	PageHeader,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import { ApiError } from './api.ts';
import { brandingOf, brandingSettings } from './branding.ts';
import { ModuleSettingRow } from './ModuleSettingRow.tsrx';
import { loadSettings } from './settings-api.ts';
import { createSectionState, saveSetting } from './settings-state.ts';

function Preview(props: { readonly branding: ApplicationBranding }) @{
	const branding = props.branding;
	<div class="branding-preview">
		<span class="branding-preview__brand">
			@if (branding.logoUrl) {
				<img
					class="branding-preview__logo"
					src={branding.logoUrl}
					alt=""
					width={22}
					height={22}
				/>
			} @else {
				<BrandMark size={22} />
			}
			{branding.appName}
		</span>
		<span class="branding-preview__row">
			<Icon name="globe" size={14} />
			{t('system.branding.preview.tab', {
				title: t('shell.workspace.title') + ' · ' +
					brandingTitleSuffix(branding),
			})}
		</span>
		<span class="branding-preview__row">
			<span
				class="branding-preview__swatch"
				style={'background:' + branding.themeColor}
			></span>
			{branding.themeColor}
		</span>
		<img
			class="branding-preview__image"
			src={branding.ogImageUrl}
			alt={t('system.branding.preview.imageAlt')}
		/>
	</div>
}

/*
 * The identity of this deployment: one platform-scoped value per field, edited
 * through the settings administration API like any other setting, so the
 * screen adds no second write path and every change lands in the audit trail.
 */
export function BrandingView(props: {
	readonly csrfToken: string;
	readonly canManage: boolean;
}) @{
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
			const module = modules.find(
				(entry) => entry.moduleId === BRANDING_MODULE_ID,
			);
			client.store.act((transaction) => {
				transaction.set(
					client.state.settings,
					brandingSettings(module?.settings ?? []),
				);
				transaction.set(client.state.status, 'idle');
				transaction.set(client.state.busyKey, null);
				transaction.set(client.state.results, new Map());
			}, 'system/branding-loaded');
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

	<>
		<PageHeader
			eyebrow={t('system.branding.page.eyebrow')}
			title={t('system.branding.page.title')}
			description={t('system.branding.page.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('system.action.refresh')}
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('system.branding.denied.title')}>{t(
					'system.branding.denied.hint',
				)}</EmptyState>
			</section>
		} @else if (status === 'error') {
			<Alert>{error}</Alert>
		} @else if (status === 'loading') {
			<section class="ui-card">
				<EmptyState icon="sparkle" title={t('system.branding.loading')}>{t(
					'system.branding.loadingHint',
				)}</EmptyState>
			</section>
		} @else if (settings.length === 0) {
			<section class="ui-card">
				<EmptyState icon="sparkle" title={t('system.branding.emptyTitle')}>{t(
					'system.branding.emptyHint',
				)}</EmptyState>
			</section>
		} @else {
			<section class="ui-card">
				<div class="ui-card__head">
					<span class="ui-card__title">
						{t('system.branding.title')}
						<small>{t('system.branding.allWorkspaces')}</small>
					</span>
				</div>
				<Preview branding={brandingOf(settings)} />
				@if (!props.canManage) {
					<p class="ui-note">
						<Icon name="shield" size={14} />
						{t('system.branding.deniedManage')}
					</p>
				}
				<div class="ui-setting-group">
					@for (const setting of settings; key setting.key) {
						<ModuleSettingRow
							setting={setting}
							canManage={props.canManage}
							busy={busyKey === setting.key}
							showScope={false}
							result={results.get(setting.key) ?? null}
							onSave={(value) => void saveSetting(
								client,
								BRANDING_MODULE_ID,
								setting.key,
								value,
								props.csrfToken,
							)}
						/>
					}
				</div>
				<p class="ui-note">
					<Icon name="info" size={14} />
					{t('system.branding.reloadNote')}
				</p>
			</section>
		}
	</>
}
