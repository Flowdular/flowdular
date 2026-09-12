import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	EmptyState,
	Icon,
	PageHeader,
	SettingRow,
	Switch,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import type { NotificationKind } from '../domain/types.ts';
import {
	loadPreferences,
	NotificationsApiError,
	notificationsErrorMessage,
	saveEmailDelivery,
	savePreference,
} from './api.ts';
import { kindLabel } from './presentation.ts';
import {
	createPreferencesClientState,
	emailDeliverySwitchState,
} from './state.ts';

export interface NotificationPreferencesViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

export function NotificationPreferencesView(
	props: NotificationPreferencesViewProps,
) @{
	const client = useMemo(() => createPreferencesClientState(), []);
	const [kinds] = useValue(client.state.kinds);
	const [preferences] = useValue(client.state.preferences);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [busyKind, setBusyKind] = useValue(client.state.busyKind);
	const [emailDelivery, setEmailDelivery] = useValue(
		client.state.emailDelivery,
	);
	const [results, setResults] = useValue(client.state.results);
	/* A kind without a stored row is enabled: the member opted out of nothing. */
	const enabled = (kind: NotificationKind): boolean =>
		preferences.find((preference) => preference.kind === kind)?.enabled ?? true;
	const emailSwitch = emailDeliverySwitchState({
		status,
		canManage: props.canManage,
		busy: busyKind !== '',
	});

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const loaded = await loadPreferences();
			client.store.act((transaction) => {
				transaction.set(client.state.kinds, loaded.kinds);
				transaction.set(client.state.preferences, loaded.preferences);
				transaction.set(
					client.state.emailDelivery,
					loaded.member.emailDelivery,
				);
				transaction.set(client.state.status, 'idle');
			}, 'notifications/preferences-loaded');
		} catch (loadError) {
			setError(
				notificationsErrorMessage(
					loadError,
					'notifications.preferences.error.load',
				),
			);
			setStatus(
				loadError instanceof NotificationsApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	/* One save at a time: every switch reads the same preference list, so a
   second toggle started mid-flight would write back a stale one. */
	const toggle = async (kind: NotificationKind, next: boolean) => {
		setBusyKind(kind);
		setError('');
		try {
			const saved = await savePreference(kind, next, props.csrfToken);
			client.store.act((transaction) => {
				transaction.set(client.state.preferences, [
					...preferences.filter((preference) => preference.kind !== kind),
					saved,
				]);
				transaction.set(client.state.results, {
					...results,
					[kind]: { ok: true, message: t('notifications.preferences.saved') },
				});
			}, 'notifications/preference-saved');
		} catch (saveError) {
			setResults({
				...results,
				[kind]: {
					ok: false,
					message: notificationsErrorMessage(
						saveError,
						'notifications.preferences.error.save',
					),
				},
			});
		} finally {
			setBusyKind('');
		}
	};

	/* The workspace-wide switch shares the one-save-at-a-time rule with the
   per-kind ones: they all write the same member. */
	const toggleEmail = async (next: boolean) => {
		setBusyKind('email');
		setError('');
		try {
			const saved = await saveEmailDelivery(next, props.csrfToken);
			client.store.act((transaction) => {
				transaction.set(client.state.emailDelivery, saved.emailDelivery);
				transaction.set(client.state.results, {
					...results,
					email: { ok: true, message: t('notifications.preferences.saved') },
				});
			}, 'notifications/email-delivery-saved');
		} catch (saveError) {
			setResults({
				...results,
				email: {
					ok: false,
					message: notificationsErrorMessage(
						saveError,
						'notifications.preferences.error.save',
					),
				},
			});
		} finally {
			setBusyKind('');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('notifications.common.workspace')}
			title={t('notifications.preferences.title')}
			description={t('notifications.preferences.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void refresh()}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('notifications.common.refreshing')
					: t('notifications.common.refresh')}
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState
					icon="shield"
					title={t('notifications.common.accessDenied')}
				>{t('notifications.preferences.denied')}</EmptyState>
			</section>
		} @else {
			<>
				@if (error) {
					<Alert>{error}</Alert>
				}
				<section class="ui-card">
					<div class="ui-card__head">
						<span class="ui-card__title">
							{t('notifications.preferences.card.title')}
							<small>{t('notifications.preferences.card.description')}</small>
						</span>
					</div>
					<div class="ui-card__body">
						@if (emailSwitch.shown) {
							<SettingRow
								label={t('notifications.preferences.emailDelivery.label')}
								description={t(
									'notifications.preferences.emailDelivery.description',
								)}
								status={results['email'] ?? null}
							>
								<Switch
									checked={emailDelivery}
									label={t('notifications.preferences.emailDelivery.label')}
									disabled={emailSwitch.disabled}
									onChange={(next) => void toggleEmail(next)}
								/>
							</SettingRow>
						}
						@if (kinds.length === 0) {
							@if (status === 'loading') {
								<p class="ui-note">
									<Icon name="refresh" size={14} />
									<span>{t('notifications.preferences.loading')}</span>
								</p>
							} @else {
								<EmptyState
									icon="activity"
									title={t('notifications.preferences.empty.title')}
								>{t('notifications.preferences.empty.hint')}</EmptyState>
							}
						} @else {
							@for (const kind of kinds; key kind) {
								<SettingRow
									label={kindLabel(kind)}
									description={t('notifications.preferences.help.' + kind)}
									status={results[kind] ?? null}
								>
									<Switch
										checked={enabled(kind)}
										label={kindLabel(kind)}
										disabled={!props.canManage || busyKind !== ''}
										onChange={(next) => void toggle(kind, next)}
									/>
								</SettingRow>
							}
						}
					</div>
					<p class="ui-note">
						<Icon name="info" size={14} />
						<span>{t('notifications.preferences.note')}</span>
					</p>
				</section>
			</>
		}
	</div>
}
