import { VariableField, type VariableFieldProps } from './VariableField.tsrx';

export interface VariableInputProps extends VariableFieldProps {}

export function VariableInput(props: VariableInputProps) @{
	<VariableField {...props} multiline={false} />
}
