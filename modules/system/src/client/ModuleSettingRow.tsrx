import { useMemo } from 'octane';
import { Button, SettingRow, Switch, Tag } from '@coreloom/ui';
import type { ModuleSettingValue } from '@coreloom/kernel';
import { cell, createStore, useValue } from 'segment-state';
import type { SettingsEntryPayload } from './settings-api.ts';

export interface ModuleSettingRowProps {
	readonly setting: SettingsEntryPayload;
	readonly canManage: boolean;
	readonly busy: boolean;
	/** Shows the scope tag on the row; off when the whole card is one scope. */
	readonly showScope: boolean;
	/** Inline result of the last save of this row; null when none. */
	readonly result: { readonly ok: boolean; readonly message: string } | null;
	readonly onSave: (value: ModuleSettingValue | null) => void;
}

function text(value: ModuleSettingValue | null): string {
	return value === null ? '' : String(value);
}

function description(definition: SettingsEntryPayload): string {
	const extra =
		definition.locked ??
			(!definition.secret && definition.hasValue
				? 'Default: ' + text(definition.defaultValue) + '.'
				: '');
	return [definition.description, extra].filter(Boolean).join(' ');
}

/* One declared setting: a switch for booleans, an input or select otherwise,
   and a write-only field for secrets. Booleans save on toggle; everything else
   waits for its Save button. */
export function ModuleSettingRow(props: ModuleSettingRowProps) @{
	const draft = useMemo(
		() => createStore({ value: cell(text(props.setting.value)) }),
		[props.setting.value],
	);
	const [value, setValue] = useValue(draft.state.value);
	const definition = props.setting;
	const disabled =
		!props.canManage || props.busy || definition.locked !== undefined;
	const dirty = value !== text(definition.value);

	const submit = () => {
		if (definition.type === 'number') {
			const parsed = Number(value);
			if (value.trim() === '' || !Number.isFinite(parsed)) return;
			props.onSave(parsed);
			return;
		}
		props.onSave(value);
	};

	<SettingRow
		label={definition.label}
		description={description(definition)}
		scopeLabel={props.showScope && definition.scope === 'platform'
			? 'All workspaces'
			: undefined}
		status={props.result}
	>
		@if (definition.type === 'boolean') {
			<Switch
				checked={definition.value === true}
				label={definition.label}
				disabled={disabled}
				onChange={(checked) => props.onSave(checked)}
			/>
		} @else if (definition.secret) {
			<>
				<input
					class="ui-input"
					type="password"
					aria-label={definition.label}
					autoComplete="off"
					placeholder={definition.hasValue ? '••••••••' : 'Not set'}
					value={value}
					disabled={disabled}
					onInput={(event) => setValue(
						(event.currentTarget as HTMLInputElement).value,
					)}
				/>
				<Tag tone={definition.hasValue ? 'success' : 'neutral'} dot>
					{definition.hasValue ? 'Configured' : 'Empty'}
				</Tag>
				<Button
					size="sm"
					variant="primary"
					disabled={disabled || value.trim() === ''}
					onClick={submit}
				>
					Set
				</Button>
				@if (definition.hasValue) {
					<Button
						size="sm"
						disabled={disabled}
						onClick={() => props.onSave(null)}
					>
						Clear
					</Button>
				}
			</>
		} @else if (definition.enum) {
			<>
				<select
					class="ui-select"
					aria-label={definition.label}
					value={value}
					disabled={disabled}
					onInput={(event) => setValue(
						(event.currentTarget as HTMLSelectElement).value,
					)}
				>
					@for (const option of definition.enum; key option) {
						<option value={option}>{option}</option>
					}
				</select>
				<Button
					size="sm"
					variant="primary"
					disabled={disabled || !dirty}
					onClick={submit}
				>
					Save
				</Button>
			</>
		} @else if (definition.multiline) {
			<>
				<textarea
					class="ui-textarea"
					aria-label={definition.label}
					value={value}
					disabled={disabled}
					onInput={(event) => setValue(
						(event.currentTarget as HTMLTextAreaElement).value,
					)}
				></textarea>
				<Button
					size="sm"
					variant="primary"
					disabled={disabled || !dirty}
					onClick={submit}
				>
					Save
				</Button>
			</>
		} @else {
			<>
				<input
					class="ui-input"
					type={definition.type === 'number' ? 'number' : 'text'}
					aria-label={definition.label}
					min={definition.min}
					max={definition.max}
					value={value}
					disabled={disabled}
					onInput={(event) => setValue(
						(event.currentTarget as HTMLInputElement).value,
					)}
				/>
				<Button
					size="sm"
					variant="primary"
					disabled={disabled || !dirty}
					onClick={submit}
				>
					Save
				</Button>
				@if (definition.hasValue) {
					<Button
						size="sm"
						disabled={disabled}
						onClick={() => props.onSave(null)}
					>
						Reset
					</Button>
				}
			</>
		}
	</SettingRow>
}
