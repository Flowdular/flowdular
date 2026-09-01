export interface SwitchProps {
	checked: boolean;
	/** Accessible name; the control renders no visible text of its own. */
	label: string;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}

export function Switch(props: SwitchProps) @{
	<button
		class={['ui-switch', props.checked && 'ui-switch--on']}
		type="button"
		role="switch"
		aria-checked={props.checked}
		aria-label={props.label}
		disabled={props.disabled ?? false}
		onClick={() => props.onChange(!props.checked)}
	>
		<i aria-hidden="true"></i>
	</button>
}
