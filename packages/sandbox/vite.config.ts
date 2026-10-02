import { flowdularEnvironment } from '@flowdular/kernel/runtime-config';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { octane } from '@octanejs/vite-plugin';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
import { sandboxDirectory } from './src/server/config.ts';
import { findFlowdularWorkspace } from './src/server/workspace-root.ts';
import {
	previewSdkRoot,
	resolvePreviewModules,
	type PreviewSessionSource,
} from './src/server/preview-modules.ts';
import { isolatePreviewHotUpdates } from './src/server/preview-hot-updates.ts';

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
const sdkRoot = await previewSdkRoot(workspace.root);

const PREVIEW_MODULE =
	/^\/preview-module\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([a-z][a-z0-9-]*)\/(.+)$/;
const PREVIEW_SUPPORT =
	/^\/preview-support\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([a-z][a-z0-9-]*)\/(.+)$/;
const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const MODULE_DIRECTORY = /^[a-z][a-z0-9-]*$/;

function objectRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/* The Vite config loads before the coding-agent TypeScript runtime. Read only
   the session identity and module list that source routing needs. Older flat
   records remain readable; writeSession now stores these in a sealed envelope. */
async function readPreviewSession(
	workspaceRoot: string,
	sessionId: string,
): Promise<PreviewSessionSource | null> {
	const stored = objectRecord(
		JSON.parse(
			await readFile(
				join(
					sandboxDirectory(workspaceRoot),
					'sessions',
					sessionId,
					'session.json',
				),
				'utf8',
			),
		),
	);
	const record = objectRecord(stored?.session ?? stored);
	if (record?.id !== sessionId) return null;
	const entries: readonly unknown[] = Array.isArray(record.modules)
		? record.modules
		: [{ id: record.moduleId, directory: record.moduleSuffix }];
	if (entries.length === 0 || entries.length > 64) return null;
	const modules = entries.map((entry) => objectRecord(entry));
	if (
		modules.some(
			(module) =>
				!module ||
				typeof module.id !== 'string' ||
				!MODULE_ID.test(module.id) ||
				typeof module.directory !== 'string' ||
				!MODULE_DIRECTORY.test(module.directory),
		)
	)
		return null;
	return {
		id: sessionId,
		modules: modules.map((module) => ({
			id: module!.id as string,
			directory: module!.directory as string,
		})),
	};
}

async function containedFile(
	root: string,
	rest: string,
): Promise<string | null> {
	if (
		rest
			.split('/')
			.some((part) => part === '..' || !part || part.includes('\\'))
	)
		return null;
	const file = resolve(root, rest);
	const inside = relative(root, file);
	if (
		!inside ||
		inside === '..' ||
		inside.startsWith(`..${sep}`) ||
		isAbsolute(inside)
	)
		return null;
	const [physicalRoot, physicalFile] = await Promise.all([
		realpath(root).catch(() => null),
		realpath(file).catch(() => null),
	]);
	if (!physicalRoot || !physicalFile) return null;
	const physicalInside = relative(physicalRoot, physicalFile);
	return physicalInside &&
		physicalInside !== '..' &&
		!physicalInside.startsWith(`..${sep}`) &&
		!isAbsolute(physicalInside)
		? file
		: null;
}

/* The preview imports draft sources by session and module directory. This
   plugin maps that URL onto the session workspace, so the browser never learns
   where the workspace lives on disk and cannot ask for anything outside a
   session's module directory. */
export function previewModules(workspaceRoot: string): Plugin {
	return {
		name: 'flowdular-preview-modules',
		enforce: 'pre',
		async resolveId(source) {
			const support = PREVIEW_SUPPORT.exec(source);
			const match = support ?? PREVIEW_MODULE.exec(source);
			if (!match) return null;
			const [, sessionId, directory, rest] = match;
			try {
				const session = await readPreviewSession(workspaceRoot, sessionId!);
				if (!session) return null;
				if (support) {
					const selected = (
						await resolvePreviewModules(workspaceRoot, session)
					).find((module) => module.support && module.directory === directory);
					return selected ? containedFile(selected.path, rest!) : null;
				}
				if (!session.modules.some((module) => module.directory === directory))
					return null;
				return containedFile(
					join(
						sandboxDirectory(workspaceRoot),
						'sessions',
						sessionId!,
						'workspace',
						'modules',
						directory!,
					),
					rest!,
				);
			} catch {
				return null;
			}
		},
	};
}

const config = {
	root: appRoot,
	plugins: [
		previewModules(workspace.root),
		...isolatePreviewHotUpdates(octane(), workspace.root),
	],
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
		fs: {
			allow: [
				appRoot,
				workspace.root,
				...(sdkRoot ? [sdkRoot] : []),
				...fontDirectories,
			],
		},
		watch: { ignored: ['**/.flowdular/data/**', '**/.coreloom/data/**'] },
	},
} satisfies import('vitest/config').UserWorkspaceConfig;

export default defineConfig(config);
