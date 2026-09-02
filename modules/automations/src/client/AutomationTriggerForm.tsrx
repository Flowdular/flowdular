import { useMemo } from 'octane';
import { t } from '@coreloom/client';
import { Alert, Button, FormField } from '@coreloom/ui';
import { createStore, useValue } from 'segment-state';
import type {
	AutomationTargetOption,
	AutomationTrigger,
} from '../domain/types.ts';
import {
	automationTargetOptions,
	automationTargetValue,
	parseAutomationTargetValue,
} from './target-selection.ts';

export interface AutomationTriggerFormValue {
	readonly targetKind: string;
	readonly targetKey: string;
	readonly label: string;
	readonly enabled: boolean;
}

export interface AutomationTriggerFormProps {
	readonly trigger: AutomationTrigger | null;
	readonly targets: readonly AutomationTargetOption[];
	readonly busy: boolean;
	/* Shown once, right after the server minted it. It is never readable again. */
	readonly secret: string;
	readonly onCancel: () => void;
	readonly onRotate: (() => Promise<void>) | undefined;
	readonly onDelete: (() => Promise<void>) | undefined;
	readonly onSubmit: (value: AutomationTriggerFormValue) => Promise<void>;
}

function stringValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

export function AutomationTriggerForm(props: AutomationTriggerFormProps) @{
	const formState = useMemo(
		() => createStore({
			enabled: props.trigger?.enabled ?? true,
			targetValue: props.trigger
				? automationTargetValue({
						kind: props.trigger.targetKind,
						key: props.trigger.targetKey,
					})
				: props.targets[0]
					? automationTargetValue(props.targets[0])
					: '',
		}),
		[],
	);
	const [enabled, setEnabled] = useValue(formState.state.enabled);
	const [targetValue, setTargetValue] = useValue(formState.state.targetValue);
	const target = parseAutomationTargetValue(targetValue);
	const options = automationTargetOptions(
		props.targets,
		props.trigger
			? {
					kind: props.trigger.targetKind,
					key: props.trigger.targetKey,
					label: props.trigger.targetName,
				}
			: null,
	);
	const endpoint = props.trigger
		? '/api/automations/triggers/' + props.trigger.id + '/fire'
		: '';

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		await props.onSubmit({
			targetKind: target.kind,
			targetKey: target.key,
			label: stringValue(form, 'label'),
			enabled,
		});
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				@if (props.secret) {
					<>
						<Alert tone="warning">{t(
							'automations.triggers.form.secretWarning',
						)}</Alert>
						<FormField
							label={t('automations.triggers.form.secret')}
							help={t('automations.triggers.form.secretHelp')}
						>
							<input class="ui-input ui-mono" readonly value={props.secret} />
						</FormField>
					</>
				}
				@if (options.length === 0 && !props.trigger) {
					<p class="ui-note">{t('automations.triggers.form.noTargets')}</p>
				}
				<div class="ui-form__row">
					<FormField label={t('automations.common.target')} required>
						<select
							class="ui-select"
							name="target"
							value={targetValue}
							onChange={(event: Event) => setTargetValue(
								(event.currentTarget as HTMLSelectElement).value,
							)}
							required
						>
							@for (const option of options; key option.value) {
								<option value={option.value} disabled={!option.available}>
									{option.label + ' · ' +
										t('automations.targetKind.' + option.kind)}
								</option>
							}
						</select>
					</FormField>
					<FormField label={t('automations.common.label')} required>
						<input
							class="ui-input"
							name="label"
							defaultValue={props.trigger?.label ?? ''}
							placeholder={t('automations.triggers.form.labelPlaceholder')}
							minlength={2}
							maxlength={120}
							required
						/>
					</FormField>
				</div>
				@if (props.trigger) {
					<FormField
						label={t('automations.triggers.form.endpoint')}
						help={t('automations.triggers.form.endpointHelp')}
					>
						<input class="ui-input ui-mono" readonly value={endpoint} />
					</FormField>
				}
				<label class="ui-checkbox">
					<input
						type="checkbox"
						checked={enabled}
						onChange={(event: Event) => setEnabled(
							(event.currentTarget as HTMLInputElement).checked,
						)}
					/>
					<span>{t('automations.common.enabledLabel')}</span>
				</label>
				@if (props.onRotate || props.onDelete) {
					<div class="ui-form__section ui-form__section--danger">
						<div class="ui-form__section-head">
							<b>{t('automations.triggers.form.dangerTitle')}</b>
							<small>{t('automations.triggers.form.dangerHint')}</small>
						</div>
						<div class="ui-form__actions">
							@if (props.onRotate) {
								<Button
									type="button"
									disabled={props.busy}
									onClick={() => void props.onRotate!()}
								>{t('automations.triggers.form.rotate')}</Button>
							}
							@if (props.onDelete) {
								<Button
									variant="danger"
									type="button"
									disabled={props.busy}
									onClick={() => void props.onDelete!()}
								>{t('automations.triggers.form.delete')}</Button>
							}
						</div>
					</div>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<Button type="button" onClick={props.onCancel}>{t(
				'automations.common.close',
			)}</Button>
			<Button variant="primary" type="submit" disabled={props.busy}>
				{props.busy
					? t('automations.common.saving')
					: props.trigger
						? t('automations.triggers.form.save')
						: t('automations.triggers.form.create')}
			</Button>
		</div>
	</form>
}
