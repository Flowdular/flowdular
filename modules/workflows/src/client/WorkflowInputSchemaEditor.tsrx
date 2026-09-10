import { t } from '@flowdular/client';
import { Alert, Button, FormField } from '@flowdular/ui';
import { useMemo } from 'octane';
import { cell, createStore, useValue } from 'segment-state';
import type { JsonSchemaV1 } from '../domain/types.ts';
import {
	INPUT_FIELD_TYPES,
	inputFields,
	removeInputField,
	updateInputField,
} from './input-model.ts';

export function WorkflowInputSchemaEditor(props: {
	readonly schema: JsonSchemaV1;
	readonly editable: boolean;
	readonly onChange: (schema: JsonSchemaV1) => void;
}) @{
	const store = useMemo(
		() => createStore({
			values: cell<Record<string, string>>({}),
			editing: '',
			error: '',
			version: 0,
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
	const [error, setError] = useValue(store.state.error);
	const [version, setVersion] = useValue(store.state.version);
	const fields = inputFields(props.schema);
	const selected = fields.find((entry) => entry.name === editing);
	const reset = () => {
		setValues({});
		setEditing('');
		setError('');
		setVersion(version + 1);
	};
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		if (!props.editable) return;
		const form = new FormData(event.currentTarget as HTMLFormElement);
		try {
			const type = String(form.get('type'));
			const field = {
				...(selected?.schema.type === type ? selected.schema : {}),
				type,
				title: String(form.get('title') ?? ''),
				description: String(form.get('description') ?? ''),
			};
			props.onChange(
				updateInputField(
					props.schema,
					editing || null,
					String(form.get('name') ?? ''),
					field,
					form.has('required'),
				),
			);
			reset();
		} catch {
			setError(t('workflows.input.fieldInvalid'));
		}
	};
	<div class="ui-form__section">
		<div class="ui-form__section-head">
			<b>{t('workflows.input.fields')}</b>
			<small>{t('workflows.input.help')}</small>
		</div>
		@for (const field of fields; key field.name) {
			<div class="workflow-mapping-row">
				<span class="ui-cell">
					<b>{String(field.schema.title || field.name)}</b>
					<small>
						{field.name + ' · ' +
							t('workflows.input.type.' + field.schema.type) +
							(field.required ? ' · ' + t('workflows.input.required') : '')}
					</small>
				</span>
				@if (props.editable) {
					<div class="ui-form__actions">
						<Button
							size="sm"
							onClick={() => {
								setValues({});
								setEditing(field.name);
								setVersion(version + 1);
							}}
						>{t('workflows.mapping.edit')}</Button>
						<Button
							size="sm"
							variant="danger"
							onClick={() => {
								props.onChange(removeInputField(props.schema, field.name));
								reset();
							}}
						>{t('workflows.mapping.remove')}</Button>
					</div>
				}
			</div>
		}
		@if (props.editable) {
			<form
				class="workflow-mapping-form"
				key={version}
				onSubmit={submit}
				onInput={captureDraft}
			>
				@if (error) {
					<Alert>{error}</Alert>
				}
				<FormField
					label={t('workflows.input.fieldName')}
					help={t('workflows.input.fieldNameHelp')}
				>
					<input
						class="ui-input ui-mono"
						name="name"
						required
						maxlength={64}
						pattern="[a-zA-Z][a-zA-Z0-9_]*"
						value={values.name ?? selected?.name ?? ''}
					/>
				</FormField>
				<FormField label={t('workflows.input.fieldLabel')}>
					<input
						class="ui-input"
						name="title"
						maxlength={120}
						value={values.title ?? String(selected?.schema.title ?? '')}
					/>
				</FormField>
				<FormField label={t('workflows.input.fieldType')}>
					<select
						class="ui-select"
						name="type"
						value={values.type ?? String(selected?.schema.type ?? 'string')}
					>
						@for (const type of INPUT_FIELD_TYPES; key type) {
							<option value={type}>{t('workflows.input.type.' + type)}</option>
						}
					</select>
				</FormField>
				<FormField label={t('workflows.input.fieldDescription')}>
					<input
						class="ui-input"
						name="description"
						maxlength={500}
						value={values.description ??
							String(selected?.schema.description ?? '')}
					/>
				</FormField>
				<label class="workflow-tool-grant">
					<input
						type="checkbox"
						name="required"
						checked={values.required === undefined
							? selected?.required ?? false
							: values.required === 'true'}
					/>
					{t('workflows.input.required')}
				</label>
				<div class="ui-form__actions">
					@if (editing) {
						<Button size="sm" onClick={reset}>{t(
							'workflows.common.cancel',
						)}</Button>
					}
					<Button type="submit" size="sm">{t(
						editing ? 'workflows.input.save' : 'workflows.input.add',
					)}</Button>
				</div>
			</form>
		}
	</div>
}
