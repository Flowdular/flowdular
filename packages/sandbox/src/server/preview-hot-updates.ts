import { relative } from 'node:path';
import type { Plugin } from 'vite';

/* Octane broadcasts full-reload for every TSRX change, including modules used
   only by preview iframes. Draft saves must invalidate cached transforms without
   navigating the operator's page. The preview refreshes at turn completion or
   on request, when its isolated worker also selects the current revision. */
export function isolatePreviewHotUpdates(
	plugins: Plugin[],
	workspaceRoot: string,
): Plugin[] {
	return plugins.map((plugin) => {
		const hook = plugin.hotUpdate;
		if (!hook) return plugin;
		const original = typeof hook === 'function' ? hook : hook.handler;
		return {
			...plugin,
			hotUpdate: {
				...(typeof hook === 'function' ? {} : hook),
				async handler(options) {
					const path = relative(workspaceRoot, options.file).replaceAll(
						'\\',
						'/',
					);
					if (/^(?:\.flowdular|\.coreloom)\/sandbox\/sessions\//.test(path)) {
						for (const environment of Object.values(
							options.server.environments,
						)) {
							const graph = environment.moduleGraph;
							for (const module of graph.getModulesByFile(options.file) ?? [])
								graph.invalidateModule(module);
						}
						return [];
					}
					return original.call(this, options);
				},
			},
		};
	});
}
