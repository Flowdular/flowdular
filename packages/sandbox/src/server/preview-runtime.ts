import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ServerRoute } from '@octanejs/app-core';
import { createRouter, type Router } from '@octanejs/app-core';
import {
	createModuleSettingsRuntime,
	createPlatformAgentRegistry,
	createPlatformCapabilityRegistry,
	createPlatformToolRegistry,
	type ModuleSettingRecord,
	type ModuleSettingValue,
	type ModuleSettingsRuntime,
	type PlatformToolRegistry,
} from '@coreloom/kernel';
import {
	createAuthRoutes,
	createAuthRuntime,
	type AuthRuntime,
	type PlatformServerComposition,
	type PlatformServerContext,
} from '@coreloom/module-auth/server';
import {
	modulePathOf,
	sessionPaths,
	type SandboxSession,
	type SessionModule,
} from './sessions.ts';
import { createIsolatedPreviewRuntime } from './preview-worker-manager.ts';

export const PREVIEW_COOKIE = 'coreloom_preview';
const PREVIEW_TENANT = 'Preview workspace';
const PREVIEW_SLUG = 'preview';
const PREVIEW_EMAIL = 'preview@sandbox.local';

export interface PreviewCredentials {
	readonly email: string;
	readonly password: string;
}

export interface PreviewModuleComposition {
	readonly id: string;
	readonly directory: string;
	readonly routes: number;
	readonly hasClient: boolean;
	readonly error: string | null;
}

export interface PreviewComposition {
	readonly sessionId: string;
	readonly revision: string;
	readonly moduleId: string;
	readonly modules: readonly PreviewModuleComposition[];
	readonly auth: AuthRuntime;
	readonly credentials: PreviewCredentials;
	readonly router: Router;
	readonly routes: readonly ServerRoute[];
	readonly moduleScopes: readonly string[];
	readonly error: string | null;
	/* The parent invokes draft routes across the process boundary. */
	request(request: Request): Promise<Response>;
	/* Releases what the draft compositions hold (database handles, timers). */
	dispose(): void | Promise<void>;
}

interface DraftComposition extends PlatformServerComposition {
	readonly close?: () => void;
}

interface DraftModule {
	readonly createServerComposition?: (
		context: PlatformServerContext,
	) => DraftComposition;
}

/* Preview settings live in memory for the life of the composition: a draft
   reads and writes them like the platform would, and nothing outlives the
   session. */
function memorySettings(): ModuleSettingsRuntime {
	const records = new Map<string, ModuleSettingRecord>();
	const keyOf = (tenantId: string, moduleId: string, key: string) =>
		`${tenantId}\0${moduleId}\0${key}`;
	return createModuleSettingsRuntime({
		load: (tenantId, moduleId) => {
			const values: Record<string, ModuleSettingValue> = {};
			for (const record of records.values()) {
				if (record.tenantId === tenantId && record.moduleId === moduleId) {
					values[record.key] = record.value;
				}
			}
			return values;
		},
		save: (record) => {
			records.set(keyOf(record.tenantId, record.moduleId, record.key), record);
		},
		clear: (tenantId, moduleId, key) => {
			records.delete(keyOf(tenantId, moduleId, key));
		},
	});
}

interface DraftManifest {
	readonly moduleDefinition?: { readonly permissions?: readonly string[] };
	readonly permissions?: readonly string[];
}

async function newestModification(directory: string): Promise<number> {
	let newest = 0;
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return newest;
	}
	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === 'dist') continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			newest = Math.max(newest, await newestModification(path));
			continue;
		}
		try {
			newest = Math.max(newest, (await stat(path)).mtimeMs);
		} catch {
			continue;
		}
	}
	return newest;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/* A module reads its database path from one environment variable. Core spells
   that name from the module id in two places: the namespace (`expenses.core`
   to CL_EXPENSES_DATABASE) and the package suffix the scaffold writes
   (`sales.orders` to CL_SALES_ORDERS_DATABASE). They agree for a single
   segment id and differ for a longer one, so a preview sets both. */
function databaseVariables(module: SessionModule): readonly string[] {
	const namespace = module.id.split('.')[0] ?? module.id;
	return [
		...new Set([
			`CL_${namespace.toUpperCase()}_DATABASE`,
			`CL_${module.directory.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}_DATABASE`,
		]),
	];
}

/* Every draft with a database writes to its own file in the session's data
   directory, the only place the preview worker may write, and the directory
   the session takes with it when it is deleted. Without this a draft resolves
   the deployment path (the worker runs with NODE_ENV=production, so
   `/data/<namespace>.db`), fails to open it, and every read answers 500. */
export function previewEnvironment(
	base: NodeJS.ProcessEnv,
	dataPath: string,
	modules: readonly SessionModule[],
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { ...base };
	for (const module of modules) {
		const file = join(dataPath, `preview-${module.directory}.db`);
		for (const variable of databaseVariables(module)) {
			environment[variable] = file;
		}
	}
	return environment;
}

/* Each session gets its own authentication runtime and database, so a preview
   runs with a real principal, real scopes, and a real CSRF contract instead of
   a stub. Everything lives inside the session directory and is thrown away
   with it. Sign-up stays closed: the only account is the one seeded here. */
async function createPreviewAuth(
	session: SandboxSession,
	workspaceRoot: string,
): Promise<{ auth: AuthRuntime; credentials: PreviewCredentials }> {
	const paths = sessionPaths(workspaceRoot, session.id, session.moduleSuffix);
	const auth = createAuthRuntime({
		databasePath: join(paths.data, 'preview-auth.db'),
		secureCookies: false,
		cookieName: 'coreloom_preview_session',
		sessionTtlMs: 12 * 60 * 60 * 1000,
		allowSignUp: false,
		emailConfirmation: false,
		signInProviders: [],
	});
	/* A throwaway credential for one ephemeral preview database, kept beside it
	   so the preview can sign in again after a reload. It never reaches the
	   connected application. */
	const credentialPath = join(paths.data, 'preview-credentials.json');
	let credentials: PreviewCredentials;
	try {
		credentials = JSON.parse(
			await readFile(credentialPath, 'utf8'),
		) as PreviewCredentials;
	} catch {
		credentials = {
			email: PREVIEW_EMAIL,
			password: `preview-${randomBytes(12).toString('base64url')}`,
		};
		await mkdir(paths.data, { recursive: true, mode: 0o700 });
		await writeFile(credentialPath, JSON.stringify(credentials), {
			encoding: 'utf8',
			mode: 0o600,
		});
	}
	if (!auth.service().findAccountAccess(credentials.email)) {
		await auth.service().signUp({
			email: credentials.email,
			password: credentials.password,
			displayName: 'Sandbox preview',
			organizationName: PREVIEW_TENANT,
			organizationSlug: PREVIEW_SLUG,
		});
	}
	return { auth, credentials };
}

async function loadDraftComposition(
	session: SandboxSession,
	module: SessionModule,
	workspaceRoot: string,
	context: Omit<PlatformServerContext, 'workspaceRoot'>,
	revision: string,
): Promise<{
	readonly composition: DraftComposition | null;
	readonly moduleScopes: readonly string[];
	readonly hasClient: boolean;
	readonly error: string | null;
}> {
	const paths = sessionPaths(workspaceRoot, session.id, session.moduleSuffix);
	const modulePath = modulePathOf(paths, module.directory);
	const platformEntry = `${pathToFileURL(join(modulePath, 'src/platform.ts')).href}?revision=${revision}`;
	const indexEntry = `${pathToFileURL(join(modulePath, 'src/index.ts')).href}?revision=${revision}`;
	const hasClient = await exists(join(modulePath, 'src/client/index.ts'));
	try {
		const draft = (await import(platformEntry)) as DraftModule;
		if (!draft.createServerComposition) {
			return {
				composition: null,
				moduleScopes: [],
				hasClient,
				error: `${module.id} does not export createServerComposition from src/platform.ts yet.`,
			};
		}
		const composition = draft.createServerComposition({
			...context,
			workspaceRoot: paths.root,
		});
		if (composition.settings) context.settings.declare(composition.settings);
		let moduleScopes: readonly string[] = [];
		try {
			const manifest = (await import(indexEntry)) as DraftManifest;
			moduleScopes =
				manifest.moduleDefinition?.permissions ?? manifest.permissions ?? [];
		} catch {
			moduleScopes = [];
		}
		return { composition, moduleScopes, hasClient, error: null };
	} catch (error) {
		return {
			composition: null,
			moduleScopes: [],
			hasClient,
			error:
				error instanceof Error
					? `${module.id}: ${error.message.slice(0, 400)}`
					: `The ${module.id} server composition could not be loaded.`,
		};
	}
}

async function disposeAll(
	compositions: readonly DraftComposition[],
): Promise<void> {
	const reversed = [...compositions].reverse();
	for (const composition of reversed) {
		try {
			await composition.stop?.();
		} catch {
			/* Continue so one broken producer cannot leave the others running. */
		}
	}
	for (const composition of reversed) {
		try {
			await composition.dispose?.();
			composition.close?.();
		} catch {
			/* A draft that fails to release is the draft's bug; the preview must
			   still move on to the next revision. */
		}
	}
}

/* A candidate preview is prepared as one generation. No draft may start until
	 every prepare hook has passed and the previous generation has released its
	 resources. A failed candidate cleans up only itself. */
export async function activatePreviewDrafts(
	drafts: readonly DraftComposition[],
	retireCurrent: () => void | Promise<void>,
): Promise<readonly string[]> {
	try {
		for (const draft of drafts) await draft.prepare?.();
	} catch (error) {
		await disposeAll(drafts);
		throw error;
	}

	await retireCurrent();
	const errors: string[] = [];
	for (const draft of drafts) {
		try {
			draft.start?.();
		} catch (error) {
			errors.push(
				error instanceof Error
					? error.message.slice(0, 400)
					: 'A draft start hook failed.',
			);
		}
	}
	return errors;
}

export interface PreviewRuntime {
	compose(session: SandboxSession): Promise<PreviewComposition>;
	cached(sessionId: string): PreviewComposition | null;
	forget(sessionId: string): void;
	/* Releases every session worker and draft composition owned by this runtime. */
	dispose(): void;
}

/* The preview API is a composition, not a proxy: the draft modules' own routes
   answer first, the session's authentication routes answer next, and anything
   left over falls through to the connected application. */
/* Called only by preview-worker.ts. Draft session source must not be imported
   into the long-lived sandbox server process. */
export function createInProcessPreviewRuntime(
	workspaceRoot: string,
): PreviewRuntime {
	const compositions = new Map<string, PreviewComposition>();

	return {
		cached: (sessionId) => compositions.get(sessionId) ?? null,
		forget: (sessionId) => {
			void Promise.resolve(compositions.get(sessionId)?.dispose()).catch(
				() => undefined,
			);
			compositions.delete(sessionId);
		},
		dispose: () => {
			for (const composition of compositions.values()) {
				void Promise.resolve(composition.dispose()).catch(() => undefined);
			}
			compositions.clear();
		},
		compose: async (session) => {
			const paths = sessionPaths(
				workspaceRoot,
				session.id,
				session.moduleSuffix,
			);
			let newest = 0;
			for (const module of session.modules) {
				newest = Math.max(
					newest,
					await newestModification(
						join(modulePathOf(paths, module.directory), 'src'),
					),
				);
			}
			const revision = String(Math.round(newest));
			const current = compositions.get(session.id);
			if (current && current.revision === revision) return current;

			const { auth, credentials } = current
				? { auth: current.auth, credentials: current.credentials }
				: await createPreviewAuth(session, workspaceRoot);
			const drafts: DraftComposition[] = [];
			const routes: ServerRoute[] = [];
			const moduleScopes = new Set<string>();
			const modules: PreviewModuleComposition[] = [];
			const errors: string[] = [];
			const agentDefinitions = createPlatformAgentRegistry();
			const context: Omit<PlatformServerContext, 'workspaceRoot'> = {
				environment: previewEnvironment(
					process.env,
					paths.data,
					session.modules,
				),
				auth,
				settings: memorySettings(),
				agentTools: createPlatformToolRegistry() as PlatformToolRegistry,
				agentDefinitions,
				capabilities: createPlatformCapabilityRegistry(),
			};
			for (const module of session.modules) {
				const draft = await loadDraftComposition(
					session,
					module,
					workspaceRoot,
					context,
					revision,
				);
				if (draft.composition) {
					drafts.push(draft.composition);
					routes.push(...draft.composition.routes);
				}
				for (const scope of draft.moduleScopes) moduleScopes.add(scope);
				if (draft.error) errors.push(draft.error);
				modules.push({
					id: module.id,
					directory: module.directory,
					routes: draft.composition?.routes.length ?? 0,
					hasClient: draft.hasClient,
					error: draft.error,
				});
			}
			agentDefinitions.seal();

			const account = auth.service().findAccountAccess(credentials.email);
			if (account && moduleScopes.size > 0) {
				const tenant = account.tenants[0];
				if (tenant) {
					auth
						.service()
						.grantMembershipScopes(account.accountId, tenant.tenantId, [
							...moduleScopes,
						]);
				}
			}

			/* Preparation is generation-wide. The current preview stays alive when
			   any candidate rejects its durable-state preflight. */
			try {
				errors.push(
					...(await activatePreviewDrafts(drafts, () => current?.dispose())),
				);
			} catch (error) {
				if (!current) auth.dispose();
				throw error;
			}
			const all = [...routes, ...createAuthRoutes(auth)];
			const composition: PreviewComposition = {
				sessionId: session.id,
				revision,
				moduleId: session.moduleId,
				modules,
				auth,
				credentials,
				routes: all,
				router: createRouter([...all]),
				moduleScopes: [...moduleScopes],
				error: errors.length > 0 ? errors.join(' ') : null,
				request: async () =>
					new Response(
						JSON.stringify({
							error: {
								code: 'PREVIEW_WORKER_ONLY',
								message: 'Preview requests run in the isolated worker.',
							},
						}),
						{ status: 500, headers: { 'content-type': 'application/json' } },
					),
				dispose: () => disposeAll(drafts),
			};
			compositions.set(session.id, composition);
			return composition;
		},
	};
}

export function createPreviewRuntime(workspaceRoot: string): PreviewRuntime {
	return createIsolatedPreviewRuntime(workspaceRoot);
}

interface ProcessPreviewSlot {
	readonly workspaceRoot: string;
	readonly runtime: PreviewRuntime;
}

const PROCESS_PREVIEW_SLOT = Symbol.for('coreloom.sandbox.preview-runtime');

function processPreviewState(): Record<symbol, ProcessPreviewSlot | undefined> {
	return globalThis as unknown as Record<
		symbol,
		ProcessPreviewSlot | undefined
	>;
}

/* Octane reloads its server route configuration inside the same Vite process.
   A module-local runtime belongs to only one generation and its workers become
   unreachable when the next generation replaces the routes. Keep exactly one
   process-owned runtime instead. A workspace switch retires the previous one. */
export function processPreviewRuntime(workspaceRoot: string): PreviewRuntime {
	const state = processPreviewState();
	const current = state[PROCESS_PREVIEW_SLOT];
	if (current?.workspaceRoot === workspaceRoot) return current.runtime;
	current?.runtime.dispose();
	const runtime = createPreviewRuntime(workspaceRoot);
	state[PROCESS_PREVIEW_SLOT] = { workspaceRoot, runtime };
	return runtime;
}

/* Tests and explicit host teardown can release the process singleton. Normal
   process exit also closes IPC, which makes every worker terminate itself. */
export function disposeProcessPreviewRuntime(): void {
	const state = processPreviewState();
	state[PROCESS_PREVIEW_SLOT]?.runtime.dispose();
	delete state[PROCESS_PREVIEW_SLOT];
}
