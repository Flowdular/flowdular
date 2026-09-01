import { initials } from '../initials.ts';

export interface AvatarProps {
	name: string;
	square?: boolean;
	large?: boolean;
}

export function Avatar(props: AvatarProps) @{
	<span
		class={[
			'ui-avatar',
			props.square && 'ui-avatar--sq',
			props.large && 'ui-avatar--lg',
		]}
		aria-hidden="true"
	>{initials(props.name)}</span>
}
