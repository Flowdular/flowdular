import { Icon } from '../icons/Icon.tsrx';

export interface SearchFieldProps {
	value: string;
	placeholder?: string;
	/** Accessible name; the control carries no visible label. */
	label?: string;
	onInput: (value: string) => void;
}

export function SearchField(props: SearchFieldProps) @{
	<label class="ui-search">
		<Icon name="search" size={16} />
		<input
			type="search"
			value={props.value}
			placeholder={props.placeholder ?? 'Search…'}
			aria-label={props.label ?? props.placeholder ?? 'Search'}
			onInput={(event: InputEvent) => props.onInput(
				(event.currentTarget as HTMLInputElement).value,
			)}
		/>
	</label>
}
