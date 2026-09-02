import { useMemo } from 'octane';
import { t, useTranslation } from '@coreloom/client';
import { Button, CheckGrid, FormField, VariableTextarea } from '@coreloom/ui';
import type { CheckGroup, CheckOption } from '@coreloom/ui';
import { cell, createStore, useValue } from 'segment-state';
import { AGENT_CONTEXT_VARIABLES } from '../domain/context-variables.ts';
import type {
	AgentDefinition,
	AgentProviderConnection,
	AgentSkill,
	CreateAgentInput,
	UpdateAgentInput,
} from '../domain/types.ts';

const CONTEXT_SAMPLE_VALUES: Record<string, string> = Object.fromEntries(
	AGENT_CONTEXT_VARIABLES.map(
		(variable) => [variable.key, variable.sample ?? ''],
	),
);

export interface AgentDefinitionFormProps {
	readonly agent: AgentDefinition | null;
	readonly providers: readonly AgentProviderConnection[];
	readonly tools: readonly string[];
	readonly skills: readonly AgentSkill[];
	readonly busy: boolean;
	readonly onCancel: () => void;
	readonly onSubmit: (input: CreateAgentInput | UpdateAgentInput) => Promise<
		void
	>;
}

function stringValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

function numberValue(form: FormData, key: string): number {
	return Number(stringValue(form, key));
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

function skillGroups(skills: readonly AgentSkill[]): readonly CheckGroup[] {
	if (skills.length === 0) return [];
	return [
		{
			label: t('agents.definitions.form.skills'),
			options: skills.map(
				(skill) => ({
					value: skill.id,
					label: skill.name,
					hint: 'r' + skill.revision + ' · ' +
						t('agents.status.' + skill.status),
				}),
			),
		},
	];
}

export function AgentDefinitionForm(props: AgentDefinitionFormProps) @{
	const { t } = useTranslation();
	const contextVariables = AGENT_CONTEXT_VARIABLES.map(
		(variable) => ({
			...variable,
			label: t('agents.variables.' + variable.key + '.label'),
		}),
	);
	const firstEnabledModel = (providerId: string) =>
		props.providers.find((provider) => provider.id === providerId)?.models.find(
			(model) => model.enabled,
		)?.id ??
			'';
	const formState = useMemo(() => {
		const providerId = props.agent?.provider ?? props.providers[0]?.id ?? '';
		return createStore({
			providerId,
			modelId: props.agent?.model ?? firstEnabledModel(providerId),
			instructions: props.agent?.instructions ?? '',
			allowedTools: cell<readonly string[]>(props.agent?.allowedTools ?? []),
			skillIds: cell<readonly string[]>(props.agent?.skillIds ?? []),
		});
	}, []);
	const [providerId, setProviderId] = useValue(formState.state.providerId);
	const [modelId, setModelId] = useValue(formState.state.modelId);
	const [instructions, setInstructions] = useValue(
		formState.state.instructions,
	);
	const [allowedTools, setAllowedTools] = useValue(
		formState.state.allowedTools,
	);
	const [skillIds, setSkillIds] = useValue(formState.state.skillIds);
	const selectedProvider =
		props.providers.find((provider) => provider.id === providerId) ?? null;
	const selectedModel =
		selectedProvider?.models.find((model) => model.id === modelId) ?? null;
	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const base: CreateAgentInput = {
			key: stringValue(form, 'key'),
			name: stringValue(form, 'name'),
			description: stringValue(form, 'description'),
			instructions,
			provider: stringValue(form, 'provider'),
			model: stringValue(form, 'model'),
			allowedTools,
			skillIds,
			maxSteps: numberValue(form, 'maxSteps'),
			timeoutMs: numberValue(form, 'timeoutMs'),
			temperature: numberValue(form, 'temperature'),
			maxOutputTokens: numberValue(form, 'maxOutputTokens'),
			status: stringValue(form, 'status') as CreateAgentInput['status'],
		};
		await props.onSubmit(
			props.agent ? { ...base, expectedRevision: props.agent.revision } : base,
		);
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<div class="ui-form__row">
					<FormField label={t('agents.definitions.form.name')} required>
						<input
							class="ui-input"
							name="name"
							defaultValue={props.agent?.name ?? ''}
							minlength={2}
							maxlength={120}
							required
						/>
					</FormField>
					<FormField label={t('agents.definitions.form.key')} required>
						<input
							class="ui-input ui-mono"
							name="key"
							defaultValue={props.agent?.key ?? ''}
							placeholder="customer-care"
							minlength={3}
							maxlength={64}
							required
						/>
					</FormField>
				</div>
				<FormField label={t('agents.definitions.form.description')} required>
					<input
						class="ui-input"
						name="description"
						defaultValue={props.agent?.description ?? ''}
						maxlength={500}
						required
					/>
				</FormField>
				<FormField
					label={t('agents.definitions.form.instructions')}
					help={t('agents.definitions.form.instructionsHelp')}
					required
				>
					<VariableTextarea
						name="instructions"
						label={t('agents.definitions.form.instructions')}
						value={instructions}
						onInput={setInstructions}
						variables={contextVariables}
						sampleValues={CONTEXT_SAMPLE_VALUES}
						insertLabel={t('agents.template.insert')}
						variablesLabel={t('agents.template.available')}
						emptyLabel={t('agents.template.empty')}
						placeholder={t('agents.definitions.form.instructionsPlaceholder')}
						minLength={8}
						maxLength={40_000}
						required
					/>
				</FormField>
				<div class="ui-form__row">
					<FormField label={t('agents.definitions.form.provider')}>
						<select
							class="ui-select"
							name="provider"
							value={providerId}
							disabled={props.providers.length === 0}
							onInput={(event) => {
								setProviderId(event.currentTarget.value);
								setModelId(firstEnabledModel(event.currentTarget.value));
							}}
						>
							@for (const provider of props.providers; key provider.id) {
								<option value={provider.id}>
									{provider.name +
										(provider.enabled
											? ''
											: ' (' + t('agents.status.disabled') + ')')}
								</option>
							}
						</select>
					</FormField>
					<FormField label={t('agents.definitions.form.model')} required>
						<select
							class="ui-select"
							name="model"
							value={modelId}
							onInput={(event) => setModelId(event.currentTarget.value)}
							disabled={!selectedProvider}
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
				<div class="ui-form__row ui-form__row--4">
					<FormField label={t('agents.definitions.form.maxSteps')} required>
						<input
							class="ui-input"
							name="maxSteps"
							type="number"
							min="1"
							max="32"
							defaultValue={String(props.agent?.maxSteps ?? 8)}
							required
						/>
					</FormField>
					<FormField label={t('agents.definitions.form.outputTokens')} required>
						<input
							class="ui-input"
							name="maxOutputTokens"
							type="number"
							min="256"
							max="65536"
							step="256"
							defaultValue={String(props.agent?.maxOutputTokens ?? 4_096)}
							required
						/>
					</FormField>
					<FormField label={t('agents.definitions.form.timeout')} required>
						<input
							class="ui-input"
							name="timeoutMs"
							type="number"
							min="250"
							max="86400000"
							defaultValue={String(props.agent?.timeoutMs ?? 30_000)}
							required
						/>
					</FormField>
					<FormField
						label={t('agents.definitions.form.temperature')}
						help={selectedModel?.supportsTemperature === false
							? t('agents.definitions.form.temperatureHelp')
							: undefined}
						required
					>
						<input
							class="ui-input"
							name="temperature"
							type="number"
							min="0"
							max="2"
							step="0.1"
							defaultValue={String(props.agent?.temperature ?? 0.2)}
							disabled={selectedModel?.supportsTemperature === false}
							required
						/>
					</FormField>
				</div>
				<div class="ui-form__row">
					<FormField label={t('agents.definitions.form.status')}>
						<select
							class="ui-select"
							name="status"
							defaultValue={props.agent?.status ?? 'draft'}
						>
							<option value="draft">{t('agents.status.draft')}</option>
							<option value="active">{t('agents.status.active')}</option>
							<option value="paused">{t('agents.status.paused')}</option>
							<option value="archived">{t('agents.status.archived')}</option>
						</select>
					</FormField>
				</div>
				<div class="ui-field">
					<span class="ui-label">{t('agents.definitions.form.skills')}</span>
					@if (props.skills.length === 0) {
						<p class="agent-empty-note">{t(
							'agents.definitions.form.skillsEmpty',
						)}</p>
					} @else {
						<CheckGrid
							groups={skillGroups(props.skills)}
							value={skillIds}
							onChange={setSkillIds}
						/>
					}
				</div>
				<div class="ui-field">
					<span class="ui-label">{t('agents.definitions.form.tools')}</span>
					@if (props.tools.length === 0) {
						<p class="agent-empty-note">{t(
							'agents.definitions.form.toolsEmpty',
						)}</p>
					} @else {
						<CheckGrid
							groups={toolGroups(props.tools)}
							value={allowedTools}
							mono
							onChange={setAllowedTools}
						/>
					}
					<span class="ui-help">{t('agents.definitions.form.toolsCount', {
						granted: allowedTools.length,
						total: props.tools.length,
					})}</span>
				</div>
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>
				{props.agent
					? t('agents.definitions.form.revisionNote', {
							revision: props.agent.revision + 1,
						})
					: t('agents.definitions.form.createNote')}
			</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>{t('agents.common.cancel')}</Button>
				<Button
					variant="primary"
					type="submit"
					disabled={props.busy || props.providers.length === 0}
				>
					{props.busy
						? t('agents.common.saving')
						: props.agent
							? t('agents.definitions.form.save')
							: t('agents.definitions.form.create')}
				</Button>
			</div>
		</div>
	</form>
}
