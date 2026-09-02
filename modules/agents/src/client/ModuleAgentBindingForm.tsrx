import { useMemo } from 'octane';
import { t } from '@coreloom/client';
import { Alert, Button, CheckGrid, FormField } from '@coreloom/ui';
import type { CheckGroup, CheckOption } from '@coreloom/ui';
import { cell, createStore, useValue } from 'segment-state';
import type {
	AgentProviderConnection,
	ModuleAgentView,
	UpdateModuleAgentBindingInput,
} from '../domain/types.ts';

export interface ModuleAgentBindingFormProps {
	readonly agent: ModuleAgentView;
	readonly providers: readonly AgentProviderConnection[];
	readonly busy: boolean;
	readonly onCancel: () => void;
	readonly onSubmit: (input: UpdateModuleAgentBindingInput) => Promise<void>;
}

function toolGroups(tools: readonly string[]): readonly CheckGroup[] {
	const groups = new Map<string, CheckOption[]>();
	for (const tool of tools) {
		const namespace = tool.split('.')[0] ?? tool;
		const options = groups.get(namespace) ?? [];
		options.push({
			value: tool,
			label: tool.slice(namespace.length + 1) || tool,
		});
		groups.set(namespace, options);
	}
	return [...groups].map(([label, options]) => ({ label, options }));
}

export function ModuleAgentBindingForm(props: ModuleAgentBindingFormProps) @{
	const firstProvider =
		props.providers.find((provider) => provider.enabled) ?? props.providers[0];
	const initialProviderId = props.agent.provider ?? firstProvider?.id ?? '';
	const firstEnabledModel = (providerId: string) =>
		props.providers.find((provider) => provider.id === providerId)?.models.find(
			(model) => model.enabled,
		)?.id ??
			'';
	const formState = useMemo(
		() => createStore({
			providerId: initialProviderId,
			modelId: props.agent.model ?? firstEnabledModel(initialProviderId),
			enabledTools: cell<readonly string[]>(props.agent.enabledTools),
		}),
		[],
	);
	const [providerId, setProviderId] = useValue(formState.state.providerId);
	const [modelId, setModelId] = useValue(formState.state.modelId);
	const [enabledTools, setEnabledTools] = useValue(
		formState.state.enabledTools,
	);
	const selectedProvider =
		props.providers.find((provider) => provider.id === providerId) ?? null;
	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		await props.onSubmit({
			agentId: props.agent.id,
			provider: providerId,
			model: modelId,
			enabledTools,
			status: form.get('status') === 'paused' ? 'paused' : 'active',
			expectedRevision: props.agent.bindingRevision ?? 0,
		});
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				@if (props.agent.unavailableReason) {
					<Alert tone="warning">{props.agent.unavailableReason}</Alert>
				}
				<div class="ui-form__section">
					<div class="ui-form__section-head">
						<b>{t('agents.moduleAgents.form.definition')}</b>
						<small>{t('agents.moduleAgents.form.definitionHelp')}</small>
					</div>
					<div class="ui-form__row">
						<FormField label={t('agents.moduleAgents.form.module')}>
							<input
								class="ui-input ui-mono"
								value={props.agent.ownership.moduleId}
								readonly
							/>
						</FormField>
						<FormField label={t('agents.moduleAgents.form.key')}>
							<input
								class="ui-input ui-mono"
								value={props.agent.key}
								readonly
							/>
						</FormField>
					</div>
					<FormField label={t('agents.moduleAgents.form.description')}>
						<input class="ui-input" value={props.agent.description} readonly />
					</FormField>
					<FormField label={t('agents.moduleAgents.form.instructions')}>
						<textarea
							class="ui-textarea"
							rows={6}
							value={props.agent.instructions}
							readonly
						/>
					</FormField>
					<div class="ui-form__row ui-form__row--4">
						<FormField label={t('agents.definitions.form.maxSteps')}>
							<input
								class="ui-input"
								value={String(props.agent.limits.maxSteps)}
								readonly
							/>
						</FormField>
						<FormField label={t('agents.definitions.form.outputTokens')}>
							<input
								class="ui-input"
								value={String(props.agent.limits.maxOutputTokens)}
								readonly
							/>
						</FormField>
						<FormField label={t('agents.definitions.form.timeout')}>
							<input
								class="ui-input"
								value={String(props.agent.limits.timeoutMs)}
								readonly
							/>
						</FormField>
						<FormField label={t('agents.definitions.form.temperature')}>
							<input
								class="ui-input"
								value={String(props.agent.limits.temperature)}
								readonly
							/>
						</FormField>
					</div>
				</div>
				<div class="ui-form__section">
					<div class="ui-form__section-head">
						<b>{t('agents.moduleAgents.form.execution')}</b>
						<small>{t('agents.moduleAgents.form.executionHelp')}</small>
					</div>
					<div class="ui-form__row">
						<FormField label={t('agents.definitions.form.provider')} required>
							<select
								class="ui-select"
								name="provider"
								value={providerId}
								disabled={props.providers.length === 0}
								onInput={(event) => {
									setProviderId(event.currentTarget.value);
									setModelId(firstEnabledModel(event.currentTarget.value));
								}}
								required
							>
								@for (const provider of props.providers; key provider.id) {
									<option
										value={provider.id}
										disabled={!provider.enabled}
									>{provider.name}</option>
								}
							</select>
						</FormField>
						<FormField label={t('agents.definitions.form.model')} required>
							<select
								class="ui-select"
								name="model"
								value={modelId}
								disabled={!selectedProvider}
								onInput={(event) => setModelId(event.currentTarget.value)}
								required
							>
								@for (const model of selectedProvider?.models.filter(
									(item) => item.enabled,
								) ??
									[]; key model.id) {
									<option value={model.id}>{model.label}</option>
								}
							</select>
						</FormField>
					</div>
					<FormField label={t('agents.definitions.form.status')}>
						<select
							class="ui-select"
							name="status"
							defaultValue={props.agent.status === 'paused'
								? 'paused'
								: 'active'}
						>
							<option value="active">{t('agents.status.active')}</option>
							<option value="paused">{t('agents.status.paused')}</option>
						</select>
					</FormField>
				</div>
				<div class="ui-form__section">
					<div class="ui-form__section-head">
						<b>{t('agents.moduleAgents.form.tools')}</b>
						<small>{t('agents.moduleAgents.form.toolsHelp')}</small>
					</div>
					@if (props.agent.allowedTools.length === 0) {
						<p class="ui-help">{t('agents.moduleAgents.form.toolsEmpty')}</p>
					} @else {
						<CheckGrid
							groups={toolGroups(props.agent.allowedTools)}
							value={enabledTools}
							mono
							disabled={props.busy}
							onChange={setEnabledTools}
						/>
					}
					<span class="ui-help">{t('agents.moduleAgents.form.toolsCount', {
						enabled: enabledTools.length,
						allowed: props.agent.allowedTools.length,
					})}</span>
				</div>
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>{t('agents.moduleAgents.form.bindingRevision', {
				revision: (props.agent.bindingRevision ?? 0) + 1,
			})}</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>{t('agents.common.cancel')}</Button>
				<Button
					variant="primary"
					type="submit"
					disabled={props.busy || props.providers.length === 0 ||
						modelId === ''}
				>
					{props.busy
						? t('agents.common.saving')
						: t('agents.moduleAgents.form.save')}
				</Button>
			</div>
		</div>
	</form>
}
