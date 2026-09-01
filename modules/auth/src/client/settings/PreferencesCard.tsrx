import { useMemo } from 'octane';
import { Button, SettingRow } from '@coreloom/ui';
import { cell, createStore, useValue } from 'segment-state';
import type { LocaleSetting } from './api.ts';

export interface PreferencesCardProps {
	readonly locale: LocaleSetting;
	readonly canManage: boolean;
	readonly busy: boolean;
	readonly result: { readonly ok: boolean; readonly message: string } | null;
	readonly onSave: (locale: string) => void;
}

/* Workspace defaults for members. The locale list comes from the workspace
   configuration; the value is the auth.core defaultLocale tenant setting. */
export function PreferencesCard(props: PreferencesCardProps) @{
	const draft = useMemo(
		() => createStore({ value: cell(props.locale.value) }),
		[
			props.locale.value,
		],
	);
	const [value, setValue] = useValue(draft.state.value);
	const dirty = value !== props.locale.value;

	<section class="ui-card">
		<div class="ui-card__head">
			<span class="ui-card__title">
				Preferences
				<small>Defaults offered to members of this workspace</small>
			</span>
		</div>
		<SettingRow
			label="Default locale"
			description={'Language offered to new members of this workspace.' +
				(props.locale.hasValue
					? ' Default: ' + props.locale.defaultValue + '.'
					: '')}
			status={props.result}
		>
			<select
				class="ui-select"
				aria-label="Default locale"
				value={value}
				disabled={!props.canManage || props.busy}
				onInput={(event) => setValue(
					(event.currentTarget as HTMLSelectElement).value,
				)}
			>
				@for (const option of props.locale.options; key option) {
					<option value={option}>{option}</option>
				}
			</select>
			<Button
				size="sm"
				variant="primary"
				disabled={!props.canManage || props.busy || !dirty}
				onClick={() => props.onSave(value)}
			>
				Save
			</Button>
		</SettingRow>
	</section>
}
