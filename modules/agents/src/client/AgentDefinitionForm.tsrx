import { useMemo } from 'octane';
import { Button, CheckGrid, FormField } from '@coreloom/ui';
import type { CheckGroup, CheckOption } from '@coreloom/ui';
import { cell, createStore, useValue } from 'segment-state';
import type {
	AgentDefinition,
	AgentProviderConnection,
	AgentSkill,
	CreateAgentInput,
	UpdateAgentInput,
} from '../domain/types.ts';

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
			label: 'Approved skills',
			options: skills.map(
				(skill) => ({
					value: skill.id,
					label: skill.name,
					hint: 'r' + skill.revision + ' · ' + skill.status,
				}),
			),
		},
	];
}

export function AgentDefinitionForm(props: AgentDefinitionFormProps) @{
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
			allowedTools: cell<readonly string[]>(props.agent?.allowedTools ?? []),
			skillIds: cell<readonly string[]>(props.agent?.skillIds ?? []),
		});
	}, []);
	const [providerId, setProviderId] = useValue(formState.state.providerId);
	const [modelId, setModelId] = useValue(formState.state.modelId);
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
			instructions: stringValue(form, 'instructions'),
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
					<FormField label="Name" required>
						<input
							class="ui-input"
							name="name"
							defaultValue={props.agent?.name ?? ''}
							minlength={2}
							maxlength={120}
							required
						/>
					</FormField>
					<FormField label="Stable key" required>
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
				<FormField label="Description" required>
					<input
						class="ui-input"
						name="description"
						defaultValue={props.agent?.description ?? ''}
						maxlength={500}
						required
					/>
				</FormField>
				<FormField
					label="System instructions"
					help="Business outcome, boundaries, escalation rules, expected output."
					required
				>
					<textarea
						class="ui-textarea"
						name="instructions"
						defaultValue={props.agent?.instructions ?? ''}
						placeholder="Define the business outcome, boundaries, escalation rules, and expected output."
						minlength={8}
						maxlength={40_000}
						required
					></textarea>
				</FormField>
				<div class="ui-form__row">
					<FormField label="Provider">
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
									{provider.name + (provider.enabled ? '' : ' (disabled)')}
								</option>
							}
						</select>
					</FormField>
					<FormField label="Model" required>
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
					<FormField label="Max steps" required>
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
					<FormField label="Output tokens" required>
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
					<FormField label="Timeout, ms" required>
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
						label="Temperature"
						help={selectedModel?.supportsTemperature === false
							? 'This model answers at its own default and ignores this value.'
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
					<FormField label="Status">
						<select
							class="ui-select"
							name="status"
							defaultValue={props.agent?.status ?? 'draft'}
						>
							<option value="draft">Draft</option>
							<option value="active">Active</option>
							<option value="paused">Paused</option>
							<option value="archived">Archived</option>
						</select>
					</FormField>
				</div>
				<div class="ui-field">
					<span class="ui-label">Approved skills</span>
					@if (props.skills.length === 0) {
						<p class="agent-empty-note">
							No reusable skills are configured for this tenant.
						</p>
					} @else {
						<CheckGrid
							groups={skillGroups(props.skills)}
							value={skillIds}
							onChange={setSkillIds}
						/>
					}
				</div>
				<div class="ui-field">
					<span class="ui-label">Explicit tool grants</span>
					@if (props.tools.length === 0) {
						<p class="agent-empty-note">
							No API or CLI tools are registered. This agent stays isolated from
							ERP data.
						</p>
					} @else {
						<CheckGrid
							groups={toolGroups(props.tools)}
							value={allowedTools}
							mono
							onChange={setAllowedTools}
						/>
					}
					<span class="ui-help">
						{allowedTools.length + ' of ' + props.tools.length +
							' registered tools granted'}
					</span>
				</div>
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>
				{props.agent
					? `Saving creates revision ${props.agent.revision + 1}.`
					: 'New agents start as drafts and cannot run until activated.'}
			</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>Cancel</Button>
				<Button
					variant="primary"
					type="submit"
					disabled={props.busy || props.providers.length === 0}
				>
					{props.busy
						? 'Saving…'
						: props.agent
							? 'Save revision'
							: 'Create draft'}
				</Button>
			</div>
		</div>
	</form>
}
