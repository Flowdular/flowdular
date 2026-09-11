// ASCII rendering of Flowdular's existing crossed-thread mark.
const MARK = [
	'    XXX     XXX',
	'    XXX     XXX',
	' XXXXXXXXXXXXXXXXX',
	'XXXXXXXXXXXXXXXXXXX',
	'    XXX     XXX',
	'XXXXXXXXXXXXXXXXXXX',
	' XXXXXXXXXXXXXXXXX',
	'    XXX     XXX',
	'    XXX     XXX',
];

/** Shared terminal branding without loading Vite or browser UI dependencies. */
export function renderBrandHeader({
	title = 'FLOWDULAR',
	subtitle = '',
	color = false,
	columns = process.stdout.columns ?? 80,
	terminal = Boolean(process.stdout.isTTY),
} = {}) {
	const brand = (text) => (color ? `\u001b[1;38;5;42m${text}\u001b[0m` : text);
	const muted = (text) => (color ? `\u001b[90m${text}\u001b[0m` : text);
	if (!terminal) {
		return `  ${brand(title)}${subtitle ? `  ${muted(subtitle)}` : ''}`;
	}
	const heading = [
		`  ${brand(title)}`,
		...(subtitle ? [`  ${muted(subtitle)}`] : []),
	];
	if (columns < 21) return heading.join('\n');
	return [...MARK.map((row) => `  ${brand(row)}`), '', ...heading].join('\n');
}
