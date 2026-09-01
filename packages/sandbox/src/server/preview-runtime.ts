import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ServerRoute } from '@octanejs/app-core';
import { createRouter, type Router } from '@octanejs/app-core';
import {
	createModuleSettingsRuntime,
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
	/* Releases what the draft compositions hold (database handles, timers). */
	dispose(): void;
}

interface DraftComposition extends PlatformServerComposition {
	readonly dispose?: () => void;
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

function disposeAll(compositions: readonly DraftComposition[]): void {
	for (const composition of compositions) {
		try {
			composition.dispose?.();
			composition.close?.();
		} catch {
			/* A draft that fails to release is the draft's bug; the preview must
			   still move on to the next revision. */
		}
	}
}

export interface PreviewRuntime {
	compose(session: SandboxSession): Promise<PreviewComposition>;
	cached(sessionId: string): PreviewComposition | null;
	forget(sessionId: string): void;
}

/* The preview API is a composition, not a proxy: the draft modules' own routes
   answer first, the session's authentication routes answer next, and anything
   left over falls through to the connected application. */
export function createPreviewRuntime(workspaceRoot: string): PreviewRuntime {
	const compositions = new Map<string, PreviewComposition>();

	return {
		cached: (sessionId) => compositions.get(sessionId) ?? null,
		forget: (sessionId) => {
			compositions.get(sessionId)?.dispose();
			compositions.delete(sessionId);
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
			const context: Omit<PlatformServerContext, 'workspaceRoot'> = {
				environment: process.env,
				auth,
				settings: memorySettings(),
				agentTools: createPlatformToolRegistry() as PlatformToolRegistry,
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

			/* Like the platform, start hooks run after every draft composed. */
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
				dispose: () => disposeAll(drafts),
			};
			/* The previous revision's drafts are released before the new one is
			   published, so a reload never stacks database handles. */
			current?.dispose();
			compositions.set(session.id, composition);
			return composition;
		},
	};
}
