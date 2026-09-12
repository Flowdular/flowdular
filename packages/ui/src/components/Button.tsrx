import type { OctaneNode } from 'octane';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
	variant?: ButtonVariant;
	size?: ButtonSize;
	type?: 'button' | 'submit';
	block?: boolean;
	disabled?: boolean;
	/** Id of the element describing the button, e.g. why this one is disabled. */
	describedBy?: string | undefined;
	onClick?: () => void;
	children?: OctaneNode;
}

export function Button(props: ButtonProps) @{
	<button
		class={[
			'ui-btn',
			'ui-btn--' + (props.variant ?? 'secondary'),
			props.size === 'sm' && 'ui-btn--sm',
			props.size === 'lg' && 'ui-btn--lg',
			props.block && 'ui-btn--block',
		]}
		type={props.type ?? 'button'}
		disabled={props.disabled ?? false}
		aria-describedby={props.describedBy}
		onClick={() => props.onClick?.()}
	>{props.children}</button>
}
