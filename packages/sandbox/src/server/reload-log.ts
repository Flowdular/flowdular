import { relative } from 'node:path';
import type { ViteDevServer } from 'vite';

/* Watch notifications describe source changes, not successful preview builds.
   Collect one bounded burst so atomic saves do not flood the terminal. */
export function watchSandboxReloads(
	server: Pick<ViteDevServer, 'watcher' | 'httpServer'>,
	appRoot: string,
	write: (message: string) => void,
	verbose = false,
): () => void {
	const groups = new Map<string, Set<string>>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pendingFiles = 0;
	const flush = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		for (const [label, files] of groups) {
			if (verbose) {
				for (const path of files) write(path);
			} else {
				write(
					`${label} · ${files.size} ${files.size === 1 ? 'file' : 'files'} changed`,
				);
			}
		}
		groups.clear();
		pendingFiles = 0;
	};
	const changed = (event: string, path: string) => {
		if (!['add', 'change', 'unlink'].includes(event)) return;
		const normalized = path.replaceAll('\\', '/');
		const draft = normalized.match(
			/\/(?:\.flowdular|\.coreloom)\/sandbox\/sessions\/([^/]+)\/workspace\/modules\/([^/]+)\//,
		);
		const local = relative(appRoot, path);
		if (
			!draft &&
			(local === '..' || local.startsWith('../') || local.startsWith('..\\'))
		)
			return;
		const label = draft
			? `Draft ${draft[2]} (${draft[1]!.slice(0, 8)})`
			: 'Sandbox';
		const files = groups.get(label) ?? new Set<string>();
		if (!files.has(path)) pendingFiles += 1;
		files.add(path);
		groups.set(label, files);
		// Fixed window, not a reset-on-every-event debounce: continuous writes
		// remain visible and retained notifications cannot grow without a flush.
		if (!timer) {
			timer = setTimeout(flush, 750);
			timer.unref?.();
		}
		if (pendingFiles >= 256) flush();
	};
	const dispose = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		groups.clear();
		pendingFiles = 0;
		server.watcher.off('all', changed);
		server.httpServer?.off('close', dispose);
	};
	server.watcher.on('all', changed);
	server.httpServer?.once('close', dispose);
	return dispose;
}
