import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { octane } from '@octanejs/vite-plugin';
import { defineConfig, type Plugin } from 'vite';
import { SANDBOX_DIRECTORY } from './src/server/config.ts';
import { findCoreloomWorkspace } from './src/server/workspace-root.ts';

const appRoot = dirname(fileURLToPath(import.meta.url));
const workspace = await findCoreloomWorkspace(
	process.env.CORELOOM_WORKSPACE ?? process.cwd(),
);

const PREVIEW_MODULE =
	/^\/preview-module\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([a-z][a-z0-9-]*)\/(.+)$/;

/* The preview imports draft sources by session and module directory. This
   plugin maps that URL onto the session workspace, so the browser never learns
   where the workspace lives on disk and cannot ask for anything outside a
   session's module directory. */
function previewModules(workspaceRoot: string): Plugin {
	return {
		name: 'coreloom-preview-modules',
		enforce: 'pre',
		resolveId(source) {
			const match = PREVIEW_MODULE.exec(source);
			if (!match) return null;
			const [, sessionId, directory, rest] = match;
			if (rest!.split('/').some((segment) => segment === '..' || !segment)) {
				return null;
			}
			const sessionRoot = join(
				workspaceRoot,
				SANDBOX_DIRECTORY,
				'sessions',
				sessionId!,
			);
			let modules: readonly { readonly directory: string }[] = [];
			try {
				const record = JSON.parse(
					readFileSync(join(sessionRoot, 'session.json'), 'utf8'),
				) as {
					modules?: readonly { readonly directory: string }[];
					moduleSuffix?: string;
				};
				modules =
					record.modules ??
					(record.moduleSuffix ? [{ directory: record.moduleSuffix }] : []);
			} catch {
				return null;
			}
			if (!modules.some((module) => module.directory === directory)) {
				return null;
			}
			const file = join(sessionRoot, 'workspace', 'modules', directory!, rest!);
			return existsSync(file) ? file : null;
		},
	};
}

export default defineConfig({
	root: appRoot,
	plugins: [previewModules(workspace.root), octane()],
	resolve: {
		/* Draft module code is loaded from a session workspace outside this app.
		   It resolves the workspace packages through the node_modules link the
		   session gets, and these must stay single instances or the preview would
		   run on a second runtime. */
		dedupe: [
			'octane',
			'segment-state',
			'@coreloom/client',
			'@coreloom/ui',
			'@coreloom/server',
			'@coreloom/contracts',
		],
		extensions: ['.tsrx', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
	},
	build: { target: 'esnext' },
	server: {
		host: '127.0.0.1',
		port: 4320,
		strictPort: true,
		/* Draft module files change on every agent turn and are served from
		   outside this app's root. The preview reloads itself instead, and a Vite
		   overlay must never cover a module someone is reviewing. */
		hmr: { overlay: false },
		fs: { allow: [appRoot, workspace.root] },
		watch: { ignored: ['**/.coreloom/**/data/**', '**/.octane-erp/**'] },
	},
});
