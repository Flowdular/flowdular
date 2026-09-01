export interface CheckOption {
	readonly value: string;
	readonly label: string;
	readonly hint?: string;
}

export interface CheckGroup {
	readonly label: string;
	readonly options: readonly CheckOption[];
}

export interface CheckGridProps {
	groups: readonly CheckGroup[];
	value: readonly string[];
	/** Renders option labels in the mono face, for identifiers and scopes. */
	mono?: boolean;
	disabled?: boolean;
	onChange: (next: readonly string[]) => void;
}

function toggle(
	value: readonly string[],
	option: string,
	checked: boolean,
): readonly string[] {
	if (checked) return value.includes(option) ? value : [...value, option];
	return value.filter((entry) => entry !== option);
}

export function CheckGrid(props: CheckGridProps) @{
	const selectGroup = (group: CheckGroup, checked: boolean) => {
		const values = group.options.map((option) => option.value);
		props.onChange(
			checked
				? [...props.value.filter((entry) => !values.includes(entry)), ...values]
				: props.value.filter((entry) => !values.includes(entry)),
		);
	};

	<div class="ui-checks">
		@for (const group of props.groups; key group.label) {
			<fieldset class="ui-checks__group">
				<div class="ui-checks__head">
					<span>{group.label}</span>
					<span class="ui-checks__count">
						{group.options.filter(
							(option) => props.value.includes(option.value),
						).length +
							'/' +
							group.options.length}
					</span>
					<button
						class="ui-checks__all"
						type="button"
						disabled={props.disabled ?? false}
						onClick={() => selectGroup(
							group,
							!group.options.every(
								(option) => props.value.includes(option.value),
							),
						)}
					>
						{group.options.every((option) => props.value.includes(option.value))
							? 'Clear'
							: 'All'}
					</button>
				</div>
				<div class="ui-checks__items">
					@for (const option of group.options; key option.value) {
						<label class={['ui-checks__option', props.mono && 'ui-mono']}>
							<input
								type="checkbox"
								checked={props.value.includes(option.value)}
								disabled={props.disabled ?? false}
								onChange={(event: Event) => props.onChange(
									toggle(
										props.value,
										option.value,
										(event.currentTarget as HTMLInputElement).checked,
									),
								)}
							/>
							<span>{option.label}</span>
							@if (option.hint) {
								<small>{option.hint}</small>
							}
						</label>
					}
				</div>
			</fieldset>
		}
	</div>
}
