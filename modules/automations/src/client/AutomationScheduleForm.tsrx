import { useMemo } from 'octane';
import { useTranslation } from '@flowdular/client';
import { Button, FormField, VariableTextarea } from '@flowdular/ui';
import type { VariableDefinition } from '@flowdular/contracts';
import { createStore, useValue } from 'segment-state';
import {
	cadenceKind,
	cadenceMinutes,
	cronExpression,
	MAX_CRON_LENGTH,
} from '../domain/cadence.ts';
import type {
	AutomationSchedule,
	AutomationTargetOption,
	CreateAutomationScheduleInput,
} from '../domain/types.ts';
import {
	automationTargetOptions,
	automationTargetValue,
	parseAutomationTargetValue,
} from './target-selection.ts';

export interface AutomationScheduleFormProps {
	readonly schedule: AutomationSchedule | null;
	readonly targets: readonly AutomationTargetOption[];
	readonly variables: readonly VariableDefinition[];
	/** Workspace zone a cron expression is read in. */
	readonly timeZone: string;
	readonly busy: boolean;
	readonly onCancel: () => void;
	readonly onDelete: (() => Promise<void>) | undefined;
	readonly onSubmit: (input: CreateAutomationScheduleInput) => Promise<void>;
}

function stringValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

export function AutomationScheduleForm(props: AutomationScheduleFormProps) @{
	const { t } = useTranslation();
	const variables = props.variables.map(
		(variable) => ({
			...variable,
			label: t('automations.variables.' + variable.key + '.label'),
		}),
	);
	const formState = useMemo(
		() => createStore({
			cadenceMode: props.schedule
				? cadenceKind(props.schedule.cadence)
				: 'every',
			enabled: props.schedule?.enabled ?? true,
			inputTemplate: props.schedule?.inputTemplate ?? '',
			targetValue: props.schedule
				? automationTargetValue({
						kind: props.schedule.targetKind,
						key: props.schedule.targetKey,
					})
				: props.targets[0]
					? automationTargetValue(props.targets[0])
					: '',
		}),
		[],
	);
	const [cadenceMode, setCadenceMode] = useValue(formState.state.cadenceMode);
	const [enabled, setEnabled] = useValue(formState.state.enabled);
	const [inputTemplate, setInputTemplate] = useValue(
		formState.state.inputTemplate,
	);
	const [targetValue, setTargetValue] = useValue(formState.state.targetValue);
	const target = parseAutomationTargetValue(targetValue);
	const options = automationTargetOptions(
		props.targets,
		props.schedule
			? {
					kind: props.schedule.targetKind,
					key: props.schedule.targetKey,
					label: props.schedule.targetName,
				}
			: null,
	);
	const availableVariables = variables.filter(
		(variable) => target.kind === 'agent' || variable.key !== 'agent.name',
	);

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		await props.onSubmit({
			targetKind: target.kind,
			targetKey: target.key,
			label: stringValue(form, 'label'),
			inputTemplate: stringValue(form, 'inputTemplate'),
			cadence: cadenceMode === 'cron'
				? 'cron:' + stringValue(form, 'cron')
				: 'every:' + stringValue(form, 'minutes'),
			enabled,
		});
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				@if (options.length === 0) {
					<p class="ui-note">{t('automations.schedules.form.noTargets')}</p>
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
							defaultValue={props.schedule?.label ?? ''}
							placeholder={t('automations.schedules.form.labelPlaceholder')}
							minlength={2}
							maxlength={120}
							required
						/>
					</FormField>
				</div>
				<div class="ui-form__row">
					<FormField label={t('automations.schedules.form.cadenceMode')}>
						<select
							class="ui-select"
							name="cadenceMode"
							value={cadenceMode}
							onChange={(event: Event) => setCadenceMode(
								(event.currentTarget as HTMLSelectElement).value === 'cron'
									? 'cron'
									: 'every',
							)}
						>
							<option value="every">{t(
								'automations.schedules.form.cadenceModeInterval',
							)}</option>
							<option value="cron">{t(
								'automations.schedules.form.cadenceModeCron',
							)}</option>
						</select>
					</FormField>
					@if (cadenceMode === 'cron') {
						<FormField
							label={t('automations.schedules.form.cron')}
							help={t('automations.schedules.form.cronHelp', {
								zone: props.timeZone,
							})}
							required
						>
							<input
								class="ui-input"
								name="cron"
								defaultValue={props.schedule
									? cronExpression(props.schedule.cadence)
									: '0 6 * * 1-5'}
								placeholder="0 6 * * 1-5"
								maxlength={MAX_CRON_LENGTH}
								required
							/>
						</FormField>
					} @else {
						<FormField
							label={t('automations.schedules.form.interval')}
							help={t('automations.schedules.form.intervalHelp')}
							required
						>
							<input
								class="ui-input"
								name="minutes"
								type="number"
								defaultValue={String(
									props.schedule &&
									cadenceKind(props.schedule.cadence) === 'every'
										? cadenceMinutes(props.schedule.cadence)
										: 60,
								)}
								min={1}
								max={10080}
								required
							/>
						</FormField>
					}
				</div>
				<FormField
					label={t('automations.schedules.form.input')}
					help={t(
						target.kind === 'workflow'
							? 'automations.schedules.form.workflowInputHelp'
							: 'automations.schedules.form.inputHelp',
					)}
					required
				>
					<VariableTextarea
						name="inputTemplate"
						value={inputTemplate}
						onInput={setInputTemplate}
						variables={availableVariables}
						sampleValues={{
							'context.today': '2026-09-02',
							'context.now': '2026-09-02T09:30:00.000Z',
							'automation.schedule.label': props.schedule?.label ??
								t('automations.template.sample.schedule'),
							'agent.name': options.find(
								(option) => option.value === targetValue,
							)?.label ??
								t('automations.template.sample.agent'),
						}}
						label={t('automations.schedules.form.input')}
						insertLabel={t('automations.template.insert')}
						variablesLabel={t('automations.template.available')}
						emptyLabel={t('automations.template.empty')}
						placeholder={t('automations.schedules.form.inputPlaceholder')}
						maxLength={10_000}
						required
					/>
				</FormField>
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
				@if (props.schedule?.disabledReason) {
					<p class="ui-help ui-help--error">{props.schedule.disabledReason}</p>
				}
				@if (props.onDelete) {
					<div class="ui-form__section ui-form__section--danger">
						<div class="ui-form__section-head">
							<b>{t('automations.schedules.form.deleteTitle')}</b>
							<small>{t('automations.schedules.form.deleteHint')}</small>
						</div>
						<div class="ui-form__actions">
							<Button
								variant="danger"
								type="button"
								disabled={props.busy}
								onClick={() => void props.onDelete!()}
							>{t('automations.schedules.form.delete')}</Button>
						</div>
					</div>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<Button type="button" onClick={props.onCancel}>{t(
				'automations.common.cancel',
			)}</Button>
			<Button variant="primary" type="submit" disabled={props.busy}>
				{props.busy
					? t('automations.common.saving')
					: t('automations.schedules.form.save')}
			</Button>
		</div>
	</form>
}
