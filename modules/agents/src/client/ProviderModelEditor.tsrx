import { useId } from 'octane';
import { t } from '@flowdular/client';
import { Button, Icon, Tag } from '@flowdular/ui';
import {
	AI_PROVIDER_CATALOG,
	modelSupportsTemperature,
} from '@flowdular/harness/catalog';
import type {
	AgentProviderKind,
	AgentProviderModel,
	AgentProviderModelConfiguration,
} from '../domain/types.ts';
import {
	modelReadinessState,
	readinessTone,
	type ModelReadinessState,
} from './presentation.ts';

export type EditableProviderKind =
	Exclude<AgentProviderKind, 'local-simulation'>;

export interface ProviderModelDraft {
	readonly uid: string;
	readonly id: string;
	readonly label: string;
	readonly enabled: boolean;
	readonly supportsTools: boolean;
	readonly supportsStreaming: boolean;
	readonly supportsWebSearch: boolean;
	readonly supportsTemperature: boolean;
}

export interface ProviderModelEditorProps {
	readonly kind: EditableProviderKind;
	readonly drafts: readonly ProviderModelDraft[];
	readonly readinessTtlMs: number;
	/* Stored models carry the readiness evidence and decide what can be tested:
   a probe always runs against what the server has, not the open form. */
	readonly saved: readonly AgentProviderModel[];
	readonly testing: string;
	readonly onTest: ((modelId: string) => void) | null;
	readonly onChange: (drafts: readonly ProviderModelDraft[]) => void;
}

let sequence = 0;

export function emptyModelDraft(): ProviderModelDraft {
	sequence += 1;
	return {
		uid: 'model-' + sequence,
		id: '',
		label: '',
		enabled: true,
		supportsTools: true,
		supportsStreaming: true,
		supportsWebSearch: false,
		supportsTemperature: true,
	};
}

export function modelDrafts(
	models: readonly AgentProviderModel[],
): readonly ProviderModelDraft[] {
	if (models.length === 0) return [emptyModelDraft()];
	return models.map(
		(model) => ({
			...emptyModelDraft(),
			id: model.id,
			label: model.label,
			enabled: model.enabled,
			supportsTools: model.supportsTools,
			supportsStreaming: model.supportsStreaming,
			supportsWebSearch: model.supportsWebSearch,
			supportsTemperature: model.supportsTemperature,
		}),
	);
}

export function draftedModels(
	drafts: readonly ProviderModelDraft[],
): readonly AgentProviderModelConfiguration[] {
	return drafts.map(
		(draft) => ({
			id: draft.id.trim(),
			label: draft.label.trim(),
			enabled: draft.enabled,
			supportsTools: draft.supportsTools,
			supportsStreaming: draft.supportsStreaming,
			supportsWebSearch: draft.supportsWebSearch,
			supportsTemperature: draft.supportsTemperature,
		}),
	);
}

export function modelDraftError(drafts: readonly ProviderModelDraft[]): string {
	if (drafts.length === 0) return t('agents.providers.models.error.required');
	if (drafts.length > 50) return t('agents.providers.models.error.maximum');
	if (drafts.some((draft) => !draft.id.trim() || !draft.label.trim())) {
		return t('agents.providers.models.error.incomplete');
	}
	const ids = drafts.map((draft) => draft.id.trim());
	if (new Set(ids).size !== ids.length) {
		return t('agents.providers.models.error.duplicate');
	}
	return '';
}

/* Typing or picking an id resets the temperature flag to the catalog rule for
   that model; the checkbox stays available for the exceptions. */
export function draftForModelId(
	draft: ProviderModelDraft,
	kind: EditableProviderKind,
	id: string,
): ProviderModelDraft {
	const known = AI_PROVIDER_CATALOG[kind].models.includes(id.trim());
	return {
		...draft,
		id,
		label: known && !draft.label.trim() ? id.trim() : draft.label,
		supportsTemperature: modelSupportsTemperature(kind, id),
	};
}

function readinessNote(
	state: ModelReadinessState,
	model: AgentProviderModel,
): string {
	if (state === 'ready') return (model.readiness.latencyMs ?? 0) + ' ms';
	if (state === 'stale') return t('agents.providers.models.evidenceExpired');
	return model.readiness.errorCode ?? '';
}

interface ModelReadinessProps {
	readonly model: AgentProviderModel | undefined;
	readonly ttlMs: number;
	readonly testing: boolean;
	readonly onTest: (() => void) | null;
}

function ModelReadiness(props: ModelReadinessProps) @{
	<div class="model-row__readiness">
		@if (props.model) {
			<>
				<Tag
					tone={readinessTone(
						modelReadinessState(props.model.readiness, props.ttlMs),
					)}
					dot
				>{t(
					'agents.providers.modelStatus.' +
						modelReadinessState(props.model.readiness, props.ttlMs),
				)}</Tag>
				<small>{readinessNote(
					modelReadinessState(props.model.readiness, props.ttlMs),
					props.model,
				)}</small>
				<Button
					size="sm"
					disabled={props.onTest === null || props.testing}
					onClick={() => props.onTest?.()}
				>
					{props.testing
						? t('agents.providers.models.testing')
						: t('agents.providers.models.test')}
				</Button>
			</>
		} @else {
			<small class="model-row__hint">{t(
				'agents.providers.models.saveBeforeTest',
			)}</small>
		}
	</div>
}

export function ProviderModelEditor(props: ProviderModelEditorProps) @{
	const listId = useId();
	const knownModels = AI_PROVIDER_CATALOG[props.kind].models;
	const patch = (uid: string, change: Partial<ProviderModelDraft>) => {
		props.onChange(
			props.drafts.map(
				(draft) => (draft.uid === uid ? { ...draft, ...change } : draft),
			),
		);
	};
	const setId = (uid: string, id: string) => {
		props.onChange(
			props.drafts.map(
				(draft) => draft.uid === uid
					? draftForModelId(draft, props.kind, id)
					: draft,
			),
		);
	};

	<div class="model-editor">
		@if (knownModels.length > 0) {
			<datalist id={listId}>
				@for (const id of knownModels; key id) {
					<option value={id}></option>
				}
			</datalist>
		}
		@for (const draft of props.drafts; key draft.uid) {
			<div class="model-row">
				<div class="model-row__ids">
					<input
						class="ui-input ui-mono"
						value={draft.id}
						list={knownModels.length > 0 ? listId : undefined}
						placeholder={knownModels[0] ?? 'model-id'}
						aria-label={t('agents.providers.models.identifier')}
						maxlength={120}
						onInput={(event) => setId(draft.uid, event.currentTarget.value)}
					/>
					<input
						class="ui-input"
						value={draft.label}
						placeholder={t('agents.providers.models.labelPlaceholder')}
						aria-label={t('agents.providers.models.label')}
						maxlength={120}
						onInput={(event) => patch(draft.uid, {
							label: event.currentTarget.value,
						})}
					/>
					<button
						class="model-row__remove"
						type="button"
						aria-label={t('agents.providers.models.remove')}
						disabled={props.drafts.length === 1}
						onClick={() => props.onChange(
							props.drafts.filter((item) => item.uid !== draft.uid),
						)}
					>
						<Icon name="x" size={16} />
					</button>
				</div>
				<div class="model-row__flags">
					<label class="ui-checkbox">
						<input
							type="checkbox"
							checked={draft.supportsTools}
							onChange={(event) => patch(draft.uid, {
								supportsTools: event.currentTarget.checked,
							})}
						/>
						<span>{t('agents.providers.models.tools')}</span>
					</label>
					<label class="ui-checkbox">
						<input
							type="checkbox"
							checked={draft.supportsStreaming}
							onChange={(event) => patch(draft.uid, {
								supportsStreaming: event.currentTarget.checked,
							})}
						/>
						<span>{t('agents.providers.models.streaming')}</span>
					</label>
					<label class="ui-checkbox">
						<input
							type="checkbox"
							checked={draft.supportsWebSearch}
							onChange={(event) => patch(draft.uid, {
								supportsWebSearch: event.currentTarget.checked,
							})}
						/>
						<span>{t('agents.providers.models.webSearch')}</span>
					</label>
					<label
						class="ui-checkbox"
						title={t('agents.providers.models.temperatureHelp')}
					>
						<input
							type="checkbox"
							checked={draft.supportsTemperature}
							onChange={(event) => patch(draft.uid, {
								supportsTemperature: event.currentTarget.checked,
							})}
						/>
						<span>{t('agents.providers.models.temperature')}</span>
					</label>
					<label class="ui-checkbox model-row__enabled">
						<input
							type="checkbox"
							checked={draft.enabled}
							onChange={(event) => patch(draft.uid, {
								enabled: event.currentTarget.checked,
							})}
						/>
						<span>{t('agents.providers.models.available')}</span>
					</label>
				</div>
				<ModelReadiness
					model={props.saved.find((model) => model.id === draft.id.trim())}
					ttlMs={props.readinessTtlMs}
					testing={props.testing === draft.id.trim()}
					onTest={props.onTest === null
						? null
						: () => props.onTest?.(draft.id.trim())}
				/>
			</div>
		}
		<div>
			<Button
				size="sm"
				disabled={props.drafts.length >= 50}
				onClick={() => props.onChange([...props.drafts, emptyModelDraft()])}
			>
				<Icon name="plus" size={14} />
				{t('agents.providers.models.add')}
			</Button>
		</div>
	</div>
}
