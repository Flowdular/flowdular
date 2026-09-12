import { useMemo } from 'octane';
import { Alert, Button, CheckGrid, FormField, Tag } from '@flowdular/ui';
import { t } from '@flowdular/client';
import { cell, createStore, useValue } from 'segment-state';
import {
	NOTIFICATION_KINDS,
	type NotificationKind,
	type WebhookSubscription,
} from '../domain/types.ts';
import { FactList } from './FactList.tsrx';
import {
	kindLabel,
	subscriptionStatusLabel,
	subscriptionStatusTone,
	timestampLabel,
} from './presentation.ts';

export interface WebhookFormValue {
	readonly name: string;
	readonly url: string;
	readonly events: readonly NotificationKind[];
	readonly description: string | null;
}

export interface WebhookFormProps {
	readonly subscription: WebhookSubscription | null;
	readonly canManage: boolean;
	readonly busy: boolean;
	/** Shown once, right after the server minted it. It is never readable again. */
	readonly secret: string;
	readonly error: string;
	readonly onCancel: () => void;
	readonly onPause: () => void;
	readonly onResume: () => void;
	readonly onDisable: () => void;
	readonly onRotate: () => void;
	readonly onDelete: () => void;
	readonly onSubmit: (value: WebhookFormValue) => void;
}

function stringValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value.trim() : '';
}

export function WebhookForm(props: WebhookFormProps) @{
	const formState = useMemo(
		() => createStore({
			events: cell<readonly string[]>(
				props.subscription ? [...props.subscription.events] : [],
			),
			copied: false,
		}),
		[],
	);
	const [events, setEvents] = useValue(formState.state.events);
	const [copied, setCopied] = useValue(formState.state.copied);
	const subscription = props.subscription;
	const editable = props.canManage && !props.busy;

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const description = stringValue(form, 'description');
		props.onSubmit({
			name: stringValue(form, 'name'),
			url: stringValue(form, 'url'),
			events: NOTIFICATION_KINDS.filter((kind) => events.includes(kind)),
			description: description === '' ? null : description,
		});
	};

	/* The clipboard is a permission the browser may refuse, and the secret is on
   screen either way; a refusal only leaves the copy confirmation unshown. */
	const copySecret = () => {
		void navigator.clipboard?.writeText(props.secret).then(
			() => setCopied(true),
			() => setCopied(false),
		);
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
				@if (props.secret) {
					<>
						<Alert tone="warning">{t(
							'notifications.webhooks.secret.warning',
						)}</Alert>
						<FormField
							label={t('notifications.webhooks.secret.label')}
							help={copied
								? t('notifications.webhooks.secret.copied')
								: t('notifications.webhooks.secret.help')}
						>
							<div class="ui-control-row">
								<input
									class="ui-input ui-mono"
									readonly
									value={props.secret}
									aria-label={t('notifications.webhooks.secret.label')}
								/>
								<Button type="button" onClick={copySecret}>{t(
									'notifications.webhooks.secret.copy',
								)}</Button>
							</div>
						</FormField>
					</>
				}
				<div class="ui-form__row">
					<FormField
						label={t('notifications.webhooks.form.name')}
						required
						help={t('notifications.webhooks.form.nameHelp')}
					>
						<input
							class="ui-input"
							name="name"
							defaultValue={subscription?.name ?? ''}
							placeholder={t('notifications.webhooks.form.namePlaceholder')}
							minlength={2}
							maxlength={120}
							disabled={!editable}
							required
						/>
					</FormField>
				</div>
				<FormField
					label={t('notifications.webhooks.form.url')}
					required
					help={t('notifications.webhooks.form.urlHelp')}
				>
					<input
						class="ui-input ui-mono"
						name="url"
						type="url"
						defaultValue={subscription?.url ?? ''}
						placeholder={t('notifications.webhooks.form.urlPlaceholder')}
						maxlength={2048}
						disabled={!editable}
						required
					/>
				</FormField>
				<FormField
					label={t('notifications.webhooks.form.events')}
					required
					help={events.length === 0
						? t('notifications.webhooks.form.eventsRequired')
						: t('notifications.webhooks.form.eventsHelp')}
				>
					<CheckGrid
						groups={[
							{
								label: t('notifications.webhooks.form.eventsGroup'),
								options: NOTIFICATION_KINDS.map(
									(kind) => ({
										value: kind,
										label: kindLabel(kind),
									}),
								),
							},
						]}
						value={events}
						disabled={!editable}
						onChange={setEvents}
					/>
				</FormField>
				<FormField
					label={t('notifications.webhooks.form.description')}
					help={t('notifications.webhooks.form.descriptionHelp')}
				>
					<textarea
						class="ui-textarea"
						name="description"
						rows={3}
						maxlength={1000}
						disabled={!editable}
						defaultValue={subscription?.description ?? ''}
						placeholder={t(
							'notifications.webhooks.form.descriptionPlaceholder',
						)}
					></textarea>
				</FormField>
				@if (subscription) {
					<div class="ui-form__section">
						<div class="ui-form__section-head">
							<b>{t('notifications.webhooks.record.title')}</b>
							<small>{t('notifications.webhooks.record.description')}</small>
						</div>
						<FactList
							facts={[
								{
									key: 'status',
									label: t('notifications.webhooks.column.status'),
									value: <Tag
										tone={subscriptionStatusTone(subscription.status)}
										dot
									>{subscriptionStatusLabel(subscription.status)}</Tag>,
								},
								{
									key: 'fingerprint',
									label: t('notifications.webhooks.column.fingerprint'),
									value: <span
										class="ui-mono"
									>{subscription.secretFingerprint}</span>,
								},
								{
									key: 'lastDelivery',
									label: t('notifications.webhooks.column.lastDelivery'),
									value: timestampLabel(subscription.lastDeliveryAt),
								},
								{
									key: 'created',
									label: t('notifications.webhooks.record.created'),
									value: timestampLabel(subscription.createdAt),
								},
							]}
						/>
						@if (props.canManage) {
							<div class="ui-form__actions">
								@if (subscription.status === 'active') {
									<Button
										type="button"
										disabled={props.busy}
										onClick={props.onPause}
									>{t('notifications.webhooks.action.pause')}</Button>
								} @else {
									<Button
										type="button"
										disabled={props.busy}
										onClick={props.onResume}
									>{t('notifications.webhooks.action.resume')}</Button>
								}
								@if (subscription.status !== 'disabled') {
									<Button
										type="button"
										disabled={props.busy}
										onClick={props.onDisable}
									>{t('notifications.webhooks.action.disable')}</Button>
								}
								<Button
									type="button"
									disabled={props.busy}
									onClick={props.onRotate}
								>{t('notifications.webhooks.action.rotate')}</Button>
							</div>
						}
					</div>
				}
				@if (subscription && props.canManage) {
					<div class="ui-form__section ui-form__section--danger">
						<div class="ui-form__section-head">
							<b>{t('notifications.webhooks.delete.sectionTitle')}</b>
							<small>
								{subscription.status === 'disabled'
									? t('notifications.webhooks.delete.hint')
									: t('notifications.webhooks.delete.blocked')}
							</small>
						</div>
						<div class="ui-form__actions">
							<Button
								variant="danger"
								type="button"
								disabled={props.busy || subscription.status !== 'disabled'}
								onClick={props.onDelete}
							>{t('notifications.webhooks.action.delete')}</Button>
						</div>
					</div>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>{t('notifications.webhooks.form.constraint')}</small>
			<div class="ui-form__actions">
				<Button type="button" onClick={props.onCancel}>{t(
					'notifications.common.close',
				)}</Button>
				@if (props.canManage) {
					<Button
						variant="primary"
						type="submit"
						disabled={props.busy || events.length === 0}
					>
						{props.busy
							? t('notifications.common.saving')
							: subscription
								? t('notifications.webhooks.action.save')
								: t('notifications.webhooks.action.create')}
					</Button>
				}
			</div>
		</div>
	</form>
}
