import type { OctaneNode } from 'octane';

export interface FormFieldProps {
	label: string;
	required?: boolean;
	help?: string | undefined;
	error?: string | undefined;
	/** The control: an element with class ui-input, ui-select, or ui-textarea. */
	children?: OctaneNode;
}

export function FormField(props: FormFieldProps) @{
	<label class="ui-field">
		<span class="ui-label">
			{props.label}
			@if (props.required) {
				<em aria-hidden="true">{' *'}</em>
			}
		</span>
		{props.children}
		@if (props.error) {
			<span class="ui-help ui-help--error" role="alert">{props.error}</span>
		} @else if (props.help) {
			<span class="ui-help">{props.help}</span>
		}
	</label>
}
