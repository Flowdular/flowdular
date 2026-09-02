export const ICON_PATHS: Readonly<Record<string, string>> = {
	dashboard: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5M9 21v-6h6v6',
	parties: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4M9 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8M17 11h5M19.5 8.5 22 11l-2.5 2.5',
	catalog: 'm12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9',
	user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
	users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M22 11h-6',
	shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Zm-3-10 2 2 4-4',
	code: 'm8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14',
	modules: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z',
	'file-text': 'M6 2h8l4 4v16H6V2Zm8 0v5h5M9 13h6M9 17h6',
	play: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-2-14 6 4-6 4V8Z',
	bot: 'M12 2v3M8 5h8a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4Zm1 7h.01M15 12h.01M9 16h6M2 11h2M20 11h2',
	flask: 'M9 2h6M10 2v6l-5.5 9.5A3 3 0 0 0 7.1 22h9.8a3 3 0 0 0 2.6-4.5L14 8V2M7 15h10',
	activity: 'M3 12h4l2.5-7 5 14 2.5-7h4',
	plug: 'M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-5 5v6M8 12h8',
	search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.3-4.3',
	'chevron-down': 'm6 9 6 6 6-6',
	'chevrons-up-down': 'm7 15 5 5 5-5M7 9l5-5 5 5',
	plus: 'M12 5v14M5 12h14',
	'panel-left': 'M3 5h18v14H3zM9 5v14',
	check: 'm5 12 5 5L20 7',
	globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20',
	filter: 'M3 5h18l-7 8v6l-4 2v-8z',
	download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3',
	more: 'M12 5h.01M12 12h.01M12 19h.01',
	external: 'M14 4h6v6M20 4l-9 9M19 14v6H4V5h6',
	alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
	x: 'M18 6 6 18M6 6l12 12',
	'sign-out': 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
	refresh: 'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6',
	help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
	key: 'M15.5 3a5.5 5.5 0 1 0-4.2 9.05L10 13.5H8v2H6v2H3v-3l6.4-6.4A5.5 5.5 0 0 0 15.5 3Zm1.2 4.3h.01',
	settings: 'M4 8h10M18 8h2M14 8a2 2 0 1 0 4 0 2 2 0 1 0-4 0M4 16h4M12 16h8M8 16a2 2 0 1 0 4 0 2 2 0 1 0-4 0',
	braces: 'M8 3c-1.7 0-2.5.9-2.5 2.7V9c0 1.2-.8 2-2 2 1.2 0 2 .8 2 2v3.3c0 1.8.8 2.7 2.5 2.7M16 3c1.7 0 2.5.9 2.5 2.7V9c0 1.2.8 2 2 2-1.2 0-2 .8-2 2v3.3c0 1.8-.8 2.7-2.5 2.7',
};

export interface IconProps {
	name: string;
	/** Rendered size in px. Default 18 (navigation), use 16 inside buttons. */
	size?: number;
	strokeWidth?: number;
}

export function Icon(props: IconProps) @{
	const size = props.size ?? 18;
	<svg
		class="ui-icon"
		viewBox="0 0 24 24"
		width={size}
		height={size}
		stroke-width={props.strokeWidth ?? 1.75}
		aria-hidden="true"
	>
		<path d={ICON_PATHS[props.name] ?? ICON_PATHS.modules} />
	</svg>
}
