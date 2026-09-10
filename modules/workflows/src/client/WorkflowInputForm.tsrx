import { t } from '@flowdular/client';
import { Alert, FormField } from '@flowdular/ui';
import { useEffect, useMemo, useRef } from 'octane';
import { cell, createStore, useValue } from 'segment-state';
import type { JsonSchemaV1, JsonValue } from '../domain/types.ts';
import {
	inputFields,
	parseInputFieldText,
	setInputValue,
} from './input-model.ts';

export function WorkflowInputForm(props: {
	readonly schema: JsonSchemaV1;
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly onValidity: (valid: boolean) => void;
}) @{
	const store = useMemo(
		() => createStore({
			error: '',
			drafts: cell<Record<string, string>>({}),
			invalid: cell<Record<string, boolean>>({}),
		}),
		[],
	);
	const [error, setError] = useValue(store.state.error);
	const [drafts, setDrafts] = useValue(store.state.drafts);
	const [invalid, setInvalid] = useValue(store.state.invalid);
	const emitted = useRef(props.value);
	useEffect(() => {
		if (props.value === emitted.current) return;
		emitted.current = props.value;
		setDrafts({});
		setInvalid({});
		setError('');
		props.onValidity(true);
	}, [props.value]);
	let parsed: Record<string, JsonValue> = {};
	try {
		const value = JSON.parse(props.value);
		if (value && typeof value === 'object' && !Array.isArray(value)) parsed =
			value;
	} catch {
	}
	const fields = inputFields(props.schema);
	const change = (name: string, type: unknown, text: string) => {
		setDrafts({ ...drafts, [name]: text });
		try {
			const value = parseInputFieldText(type, text);
			const next = setInputValue(props.value, name, value);
			emitted.current = next;
			props.onChange(next);
			const remaining = { ...invalid, [name]: false };
			setInvalid(remaining);
			const valid = !Object.values(remaining).some(Boolean);
			setError(valid ? '' : t('workflows.input.valueInvalid'));
			props.onValidity(valid);
		} catch {
			setInvalid({ ...invalid, [name]: true });
			setError(t('workflows.input.valueInvalid'));
			props.onValidity(false);
		}
	};
	<div class="ui-form">
		@if (error) {
			<Alert>{error}</Alert>
		}
		@for (const field of fields; key field.name) {
			<FormField
				label={String(field.schema.title || field.name)}
				required={field.required}
				help={String(field.schema.description ?? '')}
			>
				@if (field.schema.type === 'boolean') {
					<select
						class="ui-select"
						value={parsed[field.name] === undefined
							? ''
							: String(parsed[field.name])}
						onInput={(event) => change(
							field.name,
							'boolean',
							event.currentTarget.value,
						)}
					>
						<option value="">{t('workflows.input.choose')}</option>
						<option value="true">{t('workflows.input.yes')}</option>
						<option value="false">{t('workflows.input.no')}</option>
					</select>
				} @else if (
					field.schema.type === 'object' || field.schema.type === 'array'
				) {
					<textarea
						class="ui-textarea ui-mono"
						rows={3}
						value={drafts[field.name] ??
							(parsed[field.name] === undefined
								? ''
								: JSON.stringify(parsed[field.name], null, 2))}
						onInput={(event) => change(
							field.name,
							field.schema.type,
							event.currentTarget.value,
						)}
					/>
				} @else {
					<input
						class="ui-input"
						type="text"
						inputmode={field.schema.type === 'number' ||
						field.schema.type === 'integer'
							? 'decimal'
							: 'text'}
						value={drafts[field.name] ?? String(parsed[field.name] ?? '')}
						onInput={(event) => change(
							field.name,
							field.schema.type,
							event.currentTarget.value,
						)}
					/>
				}
			</FormField>
		}
	</div>
}
