import { flowdularEnvironment } from '@flowdular/kernel/runtime-config';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { octane } from '@octanejs/vite-plugin';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import { sandboxDirectory } from './src/server/config.ts';
import { findFlowdularWorkspace } from './src/server/workspace-root.ts';
import { resolvePreviewModules } from './src/server/preview-modules.ts';
import type { SandboxSession } from './src/server/sessions.ts';

Object.assign(process.env, flowdularEnvironment(process.env));

const appRoot = dirname(fileURLToPath(import.meta.url));
// npx installs UI dependencies beside the sandbox, outside the app/workspace.
// Allow only the font asset directories, never the surrounding npm cache.
const uiRequire = createRequire(import.meta.resolve('@flowdular/ui'));
const fontDirectories = [
	'@fontsource-variable/ibm-plex-sans',
	'@fontsource/ibm-plex-mono',
].map((name) => join(dirname(uiRequire.resolve(name)), 'files'));
const workspace = await findFlowdularWorkspace(
	process.env.FD_SANDBOX_WORKSPACE ?? process.cwd(),
);

const PREVIEW_MODULE =
	/^\/preview-module\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([a-z][a-z0-9-]*)\/(.+)$/;

/* The preview imports draft sources by session and module directory. This
   plugin maps that URL onto the session workspace, so the browser never learns
   where the workspace lives on disk and cannot ask for anything outside a
   session's module directory. */
function previewModules(workspaceRoot: string): Plugin {
	return {
		name: 'flowdular-preview-modules',
		enforce: 'pre',
		async resolveId(source) {
			const support =
				/^\/preview-support\/([0-9a-f-]{36})\/([a-z][a-z0-9-]*)\/(.+)$/.exec(
					source,
				);
			if (support) {
				const [, sessionId, directory, rest] = support;
				if (rest!.split('/').some((part) => part === '..' || !part))
					return null;
				try {
					const session = JSON.parse(
						readFileSync(
							join(
								sandboxDirectory(workspaceRoot),
								'sessions',
								sessionId!,
								'session.json',
							),
							'utf8',
						),
					) as SandboxSession;
					const selected = (
						await resolvePreviewModules(workspaceRoot, session)
					).find((module) => module.support && module.directory === directory);
					if (!selected) return null;
					const file = join(selected.path, rest!);
					return existsSync(file) ? file : null;
				} catch {
					return null;
				}
			}
			const match = PREVIEW_MODULE.exec(source);
			if (!match) return null;
			const [, sessionId, directory, rest] = match;
			if (rest!.split('/').some((segment) => segment === '..' || !segment)) {
				return null;
			}
			const sessionRoot = join(
				sandboxDirectory(workspaceRoot),
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

const config = {
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
			'@flowdular/sdk',
			'@flowdular/client',
			'@flowdular/ui',
			'@flowdular/server',
			'@flowdular/contracts',
		],
		extensions: ['.tsrx', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
	},
	build: { target: 'esnext' },
	/* Suites here boot the embedded PostgreSQL, which costs well past the 5s
	   vitest default under a full workspace run. Vitest reads this file, so the
	   timeouts live here rather than in a vitest.config.ts that would shadow it
	   and take the preview plugins with it. */
	test: { testTimeout: 30_000, hookTimeout: 30_000 },
	server: {
		host: '127.0.0.1',
		port: 4320,
		strictPort: true,
		/* Draft module files change on every agent turn and are served from
		   outside this app's root. The preview reloads itself instead, and a Vite
		   overlay must never cover a module someone is reviewing. */
		hmr: { overlay: false },
		fs: { allow: [appRoot, workspace.root, ...fontDirectories] },
		watch: { ignored: ['**/.flowdular/data/**', '**/.coreloom/data/**'] },
	},
} satisfies import('vitest/config').UserWorkspaceConfig;

export default defineConfig(config);
