import { createLogger } from 'vite';

/* Developer-facing startup output, shared by every Flowdular launcher. One
   presentation for the platform and the sandbox: the same brand block, the same
   quiet default, and the same event prefixes. */

const ansiPattern = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ansi = {
	reset: '\u001B[0m',
	brand: '\u001B[1;38;5;42m',
	label: '\u001B[2;37m',
	text: '\u001B[37m',
	success: '\u001B[38;5;42m',
	info: '\u001B[36m',
	warning: '\u001B[33m',
	error: '\u001B[31m',
	muted: '\u001B[90m',
};

export function shouldUseColor(
	environment = process.env,
	isTerminal = process.stdout.isTTY,
) {
	if (
		Object.hasOwn(environment, 'FORCE_COLOR') &&
		environment.FORCE_COLOR !== '0'
	) {
		return true;
	}
	if (Object.hasOwn(environment, 'NO_COLOR')) return false;
	if (environment.TERM === 'dumb') return false;
	return Boolean(
		isTerminal || environment.COLORTERM || environment.TERM_PROGRAM,
	);
}

export function createTheme(enabled) {
	const paint = (code) =>
		enabled
			? (value) => `${code}${String(value)}${ansi.reset}`
			: (value) => String(value);
	return {
		enabled,
		brand: paint(ansi.brand),
		label: paint(ansi.label),
		text: paint(ansi.text),
		success: paint(ansi.success),
		info: paint(ansi.info),
		warning: paint(ansi.warning),
		error: paint(ansi.error),
		muted: paint(ansi.muted),
	};
}

export function formatDevEvent(kind, message, useColor = shouldUseColor()) {
	const theme = createTheme(useColor);
	const label = kind === 'process' ? '[octane]' : `[octane:${kind}]`;
	const tone =
		kind === 'error'
			? theme.error
			: kind === 'notice'
				? theme.warning
				: kind === 'routes'
					? theme.success
					: kind === 'reload'
						? theme.info
						: theme.muted;
	return `${tone(label)} ${tone(message)}`;
}

export function clean(message) {
	return String(message).replace(ansiPattern, '').trim();
}

export function statusLine(theme, label, value, tone = 'text') {
	return `  ${theme.label(label.padEnd(12))}${theme[tone](value)}`;
}

/* The brand block every launcher prints when it is ready. `lines` are
   `[label, value, tone]` triples, so each application names its own facts. */
export function printReady({ title, subtitle, lines, theme }) {
	console.log('');
	console.log(`  ${theme.brand(title)}  ${theme.muted(subtitle)}`);
	for (const [label, value, tone = 'text'] of lines) {
		if (value === null || value === undefined) continue;
		console.log(statusLine(theme, label, value, tone));
	}
	console.log('');
}

export function createOctaneLogger(verbose, useColor) {
	const viteLogger = createLogger('info', { allowClearScreen: false });
	const warnings = new Set();
	let hasWarned = false;
	const warn = (message, options) => {
		hasWarned = true;
		if (verbose) {
			viteLogger.warn(message, options);
			return;
		}
		const normalized = clean(message);
		if (warnings.has(normalized)) return;
		warnings.add(normalized);
		if (warnings.size === 1) {
			console.warn(
				formatDevEvent(
					'notice',
					'Tool warnings are hidden. Restart with --verbose to inspect them.',
					useColor,
				),
			);
		}
	};
	return {
		get hasWarned() {
			return hasWarned;
		},
		info(message, options) {
			if (verbose) viteLogger.info(message, options);
		},
		warn,
		warnOnce(message, options) {
			if (verbose) {
				hasWarned = true;
				viteLogger.warnOnce(message, options);
				return;
			}
			if (!warnings.has(clean(message))) warn(message, options);
		},
		error(message, options) {
			console.error(formatDevEvent('error', clean(message), useColor));
			if (verbose && options?.error?.stack) {
				console.error(options.error.stack);
			}
		},
		clearScreen() {},
		hasErrorLogged(error) {
			return viteLogger.hasErrorLogged(error);
		},
	};
}

/* A closed tab or a client-side navigation aborts the SSR stream, and octane
   reports that abort as a render error. Nothing in the app failed, so the line
   stays hidden unless --verbose asks for everything. */
export function isClientDisconnectLog(values) {
	if (typeof values[0] !== 'string') return false;
	if (!values[0].startsWith('[octane] SSR render error:')) return false;
	return values
		.slice(1)
		.some(
			(value) =>
				value instanceof Error && value.message.includes('client disconnected'),
		);
}

export function installOctaneConsoleBridge(verbose, useColor) {
	const originalLog = console.log.bind(console);
	const originalError = console.error.bind(console);
	console.log = (...values) => {
		const message = values[0];
		if (
			!verbose &&
			typeof message === 'string' &&
			message.startsWith('[@octanejs/vite-plugin]')
		) {
			const loaded = message.match(/Loaded (\d+) routes/);
			const reloaded = message.match(/Reloaded (\d+) routes/);
			if (loaded) {
				originalLog(
					formatDevEvent('routes', `${loaded[1]} routes loaded`, useColor),
				);
			} else if (reloaded) {
				originalLog(
					formatDevEvent('routes', `${reloaded[1]} routes reloaded`, useColor),
				);
			}
			return;
		}
		originalLog(...values);
	};
	console.error = (...values) => {
		const message = values[0];
		if (!verbose && isClientDisconnectLog(values)) return;
		if (
			typeof message === 'string' &&
			message.startsWith('[@octanejs/vite-plugin]')
		) {
			originalError(
				formatDevEvent(
					'error',
					message.slice('[@octanejs/vite-plugin]'.length).trim(),
					useColor,
				),
				...values.slice(1),
			);
			return;
		}
		originalError(...values);
	};
	return () => {
		console.log = originalLog;
		console.error = originalError;
	};
}

/* One reload line per change, with the repeated events a watcher emits for a
   single save collapsed. */
export function watchReloads(server, root, useColor) {
	let lastChange = '';
	let lastChangeAt = 0;
	server.watcher.on('change', (path) => {
		const changed = path.startsWith(root) ? path.slice(root.length + 1) : path;
		const now = Date.now();
		if (changed === lastChange && now - lastChangeAt < 100) return;
		lastChange = changed;
		lastChangeAt = now;
		console.log(formatDevEvent('reload', changed, useColor));
	});
}
