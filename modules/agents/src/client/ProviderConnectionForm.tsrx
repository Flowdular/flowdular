import { useMemo } from 'octane';
import { Button, FormField } from '@coreloom/ui';
import { cell, createStore, useValue } from 'segment-state';
import type {
	AgentProviderConnection,
	AgentProviderKind,
	CreateAgentProviderInput,
	UpdateAgentProviderInput,
} from '../domain/types.ts';
import { modelReadinessState } from './presentation.ts';
import {
	ProviderModelEditor,
	draftedModels,
	modelDraftError,
	modelDrafts,
	type ProviderModelDraft,
} from './ProviderModelEditor.tsrx';

type MutableProviderKind = Exclude<AgentProviderKind, 'local-simulation'>;

export interface ProviderConnectionFormProps {
	readonly provider: AgentProviderConnection | null;
	readonly busy: boolean;
	readonly readinessTtlMs: number;
	readonly testingModel: string;
	readonly onCancel: () => void;
	readonly onSubmit: (input: | CreateAgentProviderInput
	| UpdateAgentProviderInput) => Promise<void>;
	readonly onTest: (providerId: string, modelId: string) => Promise<void>;
}

function stringValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value.trim() : '';
}

export function ProviderConnectionForm(props: ProviderConnectionFormProps) @{
	const formState = useMemo(
		() => createStore({
			kind: cell<MutableProviderKind>(
				props.provider?.kind === 'local-simulation'
					? 'openai'
					: props.provider?.kind ?? 'openai',
			),
			models: cell<readonly ProviderModelDraft[]>(
				modelDrafts(props.provider?.models ?? []),
			),
		}),
		[],
	);
	const [kind, setKind] = useValue(formState.state.kind);
	const [models, setModels] = useValue(formState.state.models);
	const modelError = modelDraftError(models);
	const proven = (props.provider?.models ?? []).some(
		(model) =>
			model.enabled &&
				modelReadinessState(model.readiness, props.readinessTtlMs) === 'ready',
	);

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const resourceName = stringValue(form, 'resourceName');
		const baseURL = stringValue(form, 'baseURL');
		const credential = stringValue(form, 'credential');
		const drafted = draftedModels(models);
		if (props.provider) {
			await props.onSubmit({
				id: props.provider.id,
				expectedRevision: props.provider.revision,
				name: stringValue(form, 'name'),
				enabled: form.get('enabled') === 'on',
				models: drafted,
				...(credential ? { credential } : {}),
				...(resourceName ? { resourceName } : {}),
				...(baseURL ? { baseURL } : {}),
			});
			return;
		}
		await props.onSubmit({
			key: stringValue(form, 'key'),
			name: stringValue(form, 'name'),
			kind,
			credential,
			models: drafted,
			...(resourceName ? { resourceName } : {}),
			...(baseURL ? { baseURL } : {}),
		});
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<div class="ui-form__row">
					<FormField label="Name" required>
						<input
							class="ui-input"
							name="name"
							defaultValue={props.provider?.name ?? ''}
							minlength={2}
							maxlength={120}
							required
						/>
					</FormField>
					<FormField
						label="Stable key"
						help={props.provider ? 'Fixed after creation.' : undefined}
						required
					>
						<input
							class="ui-input ui-mono"
							name="key"
							defaultValue={props.provider?.key ?? ''}
							disabled={Boolean(props.provider)}
							placeholder="primary-openai"
							minlength={3}
							maxlength={64}
							required={!props.provider}
						/>
					</FormField>
				</div>
				<FormField label="Provider type" required>
					<select
						class="ui-select"
						name="kind"
						value={kind}
						disabled={Boolean(props.provider)}
						onInput={(event) => setKind(
							event.currentTarget.value as MutableProviderKind,
						)}
					>
						<option value="vercel">Vercel AI Gateway</option>
						<option value="openai">OpenAI</option>
						<option value="azure">Azure OpenAI</option>
						<option value="anthropic">Anthropic</option>
						<option value="openai-compatible">OpenAI-compatible</option>
					</select>
				</FormField>
				@if (kind === 'azure') {
					<FormField label="Azure resource name" required>
						<input
							class="ui-input"
							name="resourceName"
							defaultValue={props.provider?.resourceName ?? ''}
							maxlength={120}
							required
						/>
					</FormField>
				}
				@if (kind === 'openai-compatible') {
					<FormField label="Allowlisted HTTPS base URL" required>
						<input
							class="ui-input"
							name="baseURL"
							type="url"
							defaultValue={props.provider?.baseURL ?? ''}
							placeholder="https://models.example.com/v1"
							maxlength={2048}
							required
						/>
					</FormField>
				}
				<FormField
					label={props.provider ? 'Rotate credential' : 'Provider credential'}
					help={props.provider
						? 'Leave blank to keep the current credential.'
						: 'Encrypted server-side and never returned to this page.'}
					required={!props.provider}
				>
					<input
						class="ui-input"
						name="credential"
						type="password"
						autocomplete="new-password"
						placeholder={props.provider ? '••••••••' : 'Paste the API key'}
						minlength={8}
						maxlength={16_384}
						required={!props.provider}
					/>
				</FormField>
				<div class="ui-field">
					<span class="ui-label">
						Models
						<em aria-hidden="true">{' *'}</em>
					</span>
					<ProviderModelEditor
						kind={kind}
						drafts={models}
						saved={props.provider?.models ?? []}
						readinessTtlMs={props.readinessTtlMs}
						testing={props.testingModel}
						onTest={props.provider
							? (modelId) => void props.onTest(props.provider!.id, modelId)
							: null}
						onChange={setModels}
					/>
					@if (modelError) {
						<span class="ui-help ui-help--error">{modelError}</span>
					} @else {
						<span class="ui-help">
							{models.filter((model) => model.enabled).length + ' of ' +
								models.length +
								' models available to agents'}
						</span>
					}
				</div>
				@if (props.provider) {
					<>
						<div class="ui-field">
							<label class="ui-checkbox provider-enable">
								<input
									type="checkbox"
									name="enabled"
									defaultChecked={props.provider.enabled}
									disabled={!proven}
								/>
								<span>Allow active agents to use this connection</span>
							</label>
							@if (proven) {
								<span class="ui-help">
									Agents may pick any model that passed its own test.
								</span>
							} @else {
								<span class="ui-help">
									Test at least one available model first. Evidence expires, so
									a model that was proven long ago has to answer again.
								</span>
							}
						</div>
					</>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>
				{props.provider
					? 'Rotating the credential invalidates readiness evidence.'
					: 'New connections are created disabled.'}
			</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>Cancel</Button>
				<Button
					variant="primary"
					type="submit"
					disabled={props.busy || modelError !== ''}
				>
					{props.busy
						? 'Saving…'
						: props.provider
							? 'Save connection'
							: 'Create connection'}
				</Button>
			</div>
		</div>
	</form>
}
