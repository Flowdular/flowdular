import { useMemo } from 'octane';
import { t } from '@flowdular/client';
import { Button, FormField } from '@flowdular/ui';
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
	readonly onDelete: (() => void) | undefined;
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
					<FormField label={t('agents.providers.form.name')} required>
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
						label={t('agents.providers.form.key')}
						help={props.provider
							? t('agents.providers.form.keyFixed')
							: undefined}
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
				<FormField label={t('agents.providers.form.type')} required>
					<select
						class="ui-select"
						name="kind"
						value={kind}
						disabled={Boolean(props.provider)}
						onInput={(event) => setKind(
							event.currentTarget.value as MutableProviderKind,
						)}
					>
						<option value="vercel">{t('agents.providers.kind.vercel')}</option>
						<option value="openai">{t('agents.providers.kind.openai')}</option>
						<option value="azure">{t('agents.providers.kind.azure')}</option>
						<option value="anthropic">{t(
							'agents.providers.kind.anthropic',
						)}</option>
						<option value="openai-compatible">{t(
							'agents.providers.kind.openai-compatible',
						)}</option>
					</select>
				</FormField>
				@if (kind === 'azure') {
					<FormField label={t('agents.providers.form.azureResource')} required>
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
					<FormField label={t('agents.providers.form.baseUrl')} required>
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
					label={props.provider
						? t('agents.providers.form.rotateCredential')
						: t('agents.providers.form.credential')}
					help={props.provider
						? t('agents.providers.form.credentialKeep')
						: t('agents.providers.form.credentialHelp')}
					required={!props.provider}
				>
					<input
						class="ui-input"
						name="credential"
						type="password"
						autocomplete="new-password"
						placeholder={props.provider
							? '••••••••'
							: t('agents.providers.form.credentialPlaceholder')}
						minlength={8}
						maxlength={16_384}
						required={!props.provider}
					/>
				</FormField>
				<div class="ui-field">
					<span class="ui-label">
						{t('agents.providers.form.models')}
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
						<span class="ui-help">{t('agents.providers.form.modelsAvailable', {
							enabled: models.filter((model) => model.enabled).length,
							total: models.length,
						})}</span>
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
								<span>{t('agents.providers.form.enable')}</span>
							</label>
							@if (proven) {
								<span class="ui-help">{t(
									'agents.providers.form.enableReady',
								)}</span>
							} @else {
								<span class="ui-help">{t(
									'agents.providers.form.enableBlocked',
								)}</span>
							}
						</div>
					</>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>
				{props.provider
					? t('agents.providers.form.rotateNote')
					: t('agents.providers.form.createNote')}
			</small>
			<div class="ui-form__actions">
				@if (props.onDelete) {
					<Button
						variant="danger"
						disabled={props.busy}
						onClick={props.onDelete}
					>{t('agents.providers.delete.confirm')}</Button>
				}
				<Button onClick={props.onCancel}>{t('agents.common.cancel')}</Button>
				<Button
					variant="primary"
					type="submit"
					disabled={props.busy || modelError !== ''}
				>
					{props.busy
						? t('agents.providers.form.saving')
						: props.provider
							? t('agents.providers.form.save')
							: t('agents.providers.form.create')}
				</Button>
			</div>
		</div>
	</form>
}
