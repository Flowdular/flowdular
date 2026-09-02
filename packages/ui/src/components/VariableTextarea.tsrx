import { VariableField, type VariableFieldProps } from './VariableField.tsrx';

export interface VariableTextareaProps extends VariableFieldProps {
	readonly rows?: number;
}

export function VariableTextarea(props: VariableTextareaProps) @{
	<VariableField {...props} multiline={true} />
}
