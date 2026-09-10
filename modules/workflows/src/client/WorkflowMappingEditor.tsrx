import { t } from '@flowdular/client';
import { Alert, Button, FormField } from '@flowdular/ui';
import { useMemo } from 'octane';
import { cell, createStore, useValue } from 'segment-state';
import type {
	WorkflowGraphV1,
	WorkflowNodeV1,
	WorkflowTargetMappingV1,
} from '../domain/types.ts';
import { upstreamPorts, validateMappingInput } from './mapping-model.ts';
import { pointerCatalog, sourcePointerCatalog } from './pointer-model.ts';
import { WorkflowPointerField } from './WorkflowPointerField.tsrx';

export function WorkflowMappingEditor(props: {
	readonly graph: WorkflowGraphV1;
	readonly node: WorkflowNodeV1;
	readonly editable: boolean;
	readonly onChange: (node: WorkflowNodeV1) => void;
}) @{
	const store = useMemo(
		() => createStore({
			values: cell<Record<string, string>>({}),
			editing: -1,
			kind: 'path',
			error: '',
			formVersion: 0,
		}),
		[],
	);
	const [values, setValues] = useValue(store.state.values);
	const captureDraft = (event: Event) => {
		const input = event.target as HTMLInputElement;
		if (input.name) setValues({
			...values,
			[input.name]: input.type === 'checkbox'
				? String(input.checked)
				: input.value,
		});
	};
	const [editing, setEditing] = useValue(store.state.editing);
	const [kind, setKind] = useValue(store.state.kind);
	const [error, setError] = useValue(store.state.error);
	const [formVersion, setFormVersion] = useValue(store.state.formVersion);
	const sources = upstreamPorts(props.graph, props.node.id);
	const mapping = props.node.mappings?.[editing];
	const binding = mapping?.binding;
	const sourceKey =
		values.source ??
			(binding?.kind === 'path'
				? binding.sourceNodeId + '|' + binding.sourcePort
				: sources[0]?.key ?? '');
	const targetCatalog = pointerCatalog(
		props.graph.schemas[props.node.inputPorts[0]?.schemaId ??
			props.node.outputPorts[0]?.schemaId ??
			''],
		false,
	);
	const sourceCatalog = sourcePointerCatalog(props.graph, sourceKey);
	const entries = (props.node.mappings ?? []).map(
		(entry, index) => ({ ...entry, index }),
	);
	const reset = () => {
		setValues({});
		setEditing(-1);
		setError('');
		setFormVersion(formVersion + 1);
	};
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		if (!props.editable) return;
		const form = new FormData(event.currentTarget as HTMLFormElement);
		try {
			const source = String(form.get('source') ?? '').split('|');
			const next: WorkflowTargetMappingV1 = {
				targetPointer: String(form.get('target') ?? ''),
				binding: kind === 'literal'
					? {
							kind: 'literal',
							value: JSON.parse(String(form.get('literal') ?? '')),
						}
					: kind === 'template'
						? {
								kind: 'template',
								template: String(form.get('template') ?? ''),
								variables: JSON.parse(String(form.get('variables') ?? '[]')),
							}
						: {
								kind: 'path',
								sourceNodeId: source[0] ?? '',
								sourcePort: source[1] ?? '',
								pointer: String(form.get('pointer') ?? ''),
							},
			};
			if (
				!validateMappingInput(next, props.graph, props.node.id)
			) throw new Error('invalid');
			const mappings = [...(props.node.mappings ?? [])];
			if (editing >= 0) mappings[editing] = next;
			else mappings.push(next);
			props.onChange({ ...props.node, mappings });
			reset();
		} catch {
			setError(t('workflows.mapping.invalid'));
		}
	};

	<div class="ui-form__section">
		<div class="ui-form__section-head">
			<b>{t('workflows.inspector.mappings')}</b>
			<small>{t('workflows.mapping.help')}</small>
		</div>
		@for (const entry of entries; key entry.index) {
			<div class="workflow-mapping-row">
				<span class="ui-cell">
					<b class="ui-mono">
						{entry.targetPointer || t('workflows.mapping.whole')}
					</b>
					<small>{t('workflows.mapping.' + entry.binding.kind)}</small>
				</span>
				@if (props.editable) {
					<>
						<Button
							size="sm"
							onClick={() => {
								setValues({});
								setEditing(entry.index);
								setKind(entry.binding.kind);
								setError('');
								setFormVersion(formVersion + 1);
							}}
						>{t('workflows.mapping.edit')}</Button>
						<Button
							size="sm"
							variant="danger"
							onClick={() => {
								props.onChange({
									...props.node,
									mappings: (props.node.mappings ?? []).filter(
										(_, index) => index !== entry.index,
									),
								});
								reset();
							}}
						>{t('workflows.mapping.remove')}</Button>
					</>
				}
			</div>
		}
		@if (props.editable) {
			<form
				class="workflow-mapping-form"
				key={props.node.id + ':' + formVersion}
				onSubmit={submit}
				onInput={captureDraft}
			>
				@if (error) {
					<Alert>{error}</Alert>
				}
				<FormField label={t('workflows.mapping.kind')}>
					<select
						class="ui-select"
						value={kind}
						onInput={(event) => setKind(event.currentTarget.value)}
					>
						<option value="path">{t('workflows.mapping.path')}</option>
						<option value="literal">{t('workflows.mapping.literal')}</option>
						<option value="template">{t('workflows.mapping.template')}</option>
					</select>
				</FormField>
				<WorkflowPointerField
					label={t('workflows.inspector.targetPointer')}
					name="target"
					value={values.target ?? mapping?.targetPointer ?? ''}
					catalog={targetCatalog}
					onInput={(value) => setValues({ ...values, target: value })}
				/>
				@if (kind === 'path') {
					<>
						<FormField label={t('workflows.inspector.mappingSource')}>
							<select
								class="ui-select"
								name="source"
								required
								value={values.source ??
									(binding?.kind === 'path'
										? binding.sourceNodeId + '|' + binding.sourcePort
										: sources[0]?.key ?? '')}
							>
								@for (const source of sources; key source.key) {
									<option value={source.key}>{source.label}</option>
								}
							</select>
						</FormField>
						<WorkflowPointerField
							label={t('workflows.inspector.sourcePointer')}
							name="pointer"
							value={values.pointer ??
								(binding?.kind === 'path' ? binding.pointer : '')}
							catalog={sourceCatalog}
							onInput={(value) => setValues({ ...values, pointer: value })}
						/>
					</>
				} @else if (kind === 'literal') {
					<FormField
						label={t('workflows.mapping.literal')}
						help={t('workflows.mapping.literalHelp')}
					>
						<textarea
							class="ui-textarea ui-mono"
							name="literal"
							required
							maxlength={16384}
							rows={3}
							value={values.literal ??
								(binding?.kind === 'literal'
									? JSON.stringify(binding.value, null, 2)
									: '{}')}
						/>
					</FormField>
				} @else {
					<>
						<FormField label={t('workflows.mapping.template')}>
							<textarea
								class="ui-textarea"
								name="template"
								maxlength={8192}
								rows={3}
								value={values.template ??
									(binding?.kind === 'template'
										? binding.template
										: '{{ value }}')}
							/>
						</FormField>
						<FormField
							label={t('workflows.mapping.variables')}
							help={t('workflows.mapping.variablesHelp')}
						>
							<textarea
								class="ui-textarea ui-mono"
								name="variables"
								maxlength={16384}
								rows={5}
								value={values.variables ??
									JSON.stringify(
										binding?.kind === 'template'
											? binding.variables
											: sources[0]
												? [
														{
															name: 'value',
															sourceNodeId: sources[0].nodeId,
															sourcePort: sources[0].port,
															pointer: '',
														},
													]
												: [],
										null,
										2,
									)}
							/>
						</FormField>
					</>
				}
				<div class="ui-form__actions">
					@if (editing >= 0) {
						<Button size="sm" onClick={reset}>{t(
							'workflows.common.cancel',
						)}</Button>
					}
					<Button
						type="submit"
						size="sm"
						disabled={kind === 'path' && sources.length === 0}
					>{t(
						editing >= 0
							? 'workflows.mapping.save'
							: 'workflows.inspector.addMapping',
					)}</Button>
				</div>
			</form>
		}
	</div>
}
