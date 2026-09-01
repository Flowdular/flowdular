import type { OctaneNode } from 'octane';

export type TagTone =
	'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'ink';

export interface TagProps {
	tone?: TagTone;
	/** Leading status dot; keeps state readable without color vision. */
	dot?: boolean;
	mono?: boolean;
	children?: OctaneNode;
}

export function Tag(props: TagProps) @{
	const tone = props.tone ?? 'neutral';
	<span
		class={[
			'ui-tag',
			tone !== 'neutral' && 'ui-tag--' + tone,
			props.mono && 'ui-tag--mono',
		]}
	>
		@if (props.dot) {
			<i aria-hidden="true"></i>
		}
		{props.children}
	</span>
}
