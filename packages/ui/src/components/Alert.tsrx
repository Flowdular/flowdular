import type { OctaneNode } from 'octane';
import { Icon } from '../icons/Icon.tsrx';

export type AlertTone = 'danger' | 'warning' | 'info';

export interface AlertProps {
	tone?: AlertTone;
	children?: OctaneNode;
}

export function Alert(props: AlertProps) @{
	const tone = props.tone ?? 'danger';
	<p class={['ui-alert', 'ui-alert--' + tone]} role="alert">
		<Icon name={tone === 'info' ? 'help' : 'alert'} size={16} />
		<span>{props.children}</span>
	</p>
}
