import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	problemResponse,
	readJsonObject,
	requiredString,
} from '@coreloom/server';
import {
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
	type AuthRuntime,
} from '@coreloom/module-auth/server';
import {
	ModuleSettingsError,
	type ModuleSettingEntry,
	type ModuleSettingsRuntime,
} from '@coreloom/kernel';
import { SYSTEM_PERMISSIONS } from '../acl/permissions.ts';
import { readModuleCatalog } from './module-catalog.ts';

export interface SystemRouteOptions {
	readonly workspaceRoot: string;
	readonly auth: AuthRuntime;
	readonly settings: ModuleSettingsRuntime;
}

const MAIL_TRANSPORT_REQUIRED =
	'Email confirmation needs a composed mail transport; none is available in this deployment.';

export interface SettingsEntryPayload {
	readonly key: string;
	readonly type: ModuleSettingEntry['definition']['type'];
	readonly scope: 'platform' | 'tenant';
	readonly label: string;
	readonly labelKey?: string;
	readonly description: string;
	readonly descriptionKey?: string;
	readonly value: ModuleSettingEntry['value'];
	readonly hasValue: boolean;
	readonly defaultValue: ModuleSettingEntry['value'];
	readonly secret: boolean;
	readonly enum?: readonly string[];
	readonly min?: number;
	readonly max?: number;
	readonly multiline?: boolean;
	/** Human-readable reason the value cannot be changed here. */
	readonly locked?: string;
	/** Client translation key for `locked`; the literal remains the fallback. */
	readonly lockedKey?: string;
}

export interface SettingsModulePayload {
	readonly moduleId: string;
	readonly name: string;
	readonly description: string;
	readonly settings: readonly SettingsEntryPayload[];
}

function entryPayload(
	entry: ModuleSettingEntry,
	mailTransport: boolean,
): SettingsEntryPayload {
	const definition = entry.definition;
	/* auth.core cannot honor email confirmation without a composed mail
	   transport; the row stays visible but locked until one exists. */
	const locked =
		entry.moduleId === 'auth.core' &&
		entry.key === 'emailConfirmation' &&
		!mailTransport
			? MAIL_TRANSPORT_REQUIRED
			: undefined;
	return {
		key: entry.key,
		type: definition.type,
		scope: definition.scope ?? 'tenant',
		label: definition.label ?? entry.key,
		...(definition.labelKey ? { labelKey: definition.labelKey } : {}),
		description: definition.description ?? '',
		...(definition.descriptionKey
			? { descriptionKey: definition.descriptionKey }
			: {}),
		value: entry.value,
		hasValue: entry.hasValue,
		defaultValue: definition.secret ? null : definition.defaultValue,
		secret: definition.secret === true,
		...(definition.enum ? { enum: definition.enum } : {}),
		...(definition.min !== undefined ? { min: definition.min } : {}),
		...(definition.max !== undefined ? { max: definition.max } : {}),
		...(definition.multiline ? { multiline: true } : {}),
		...(locked
			? {
					locked,
					lockedKey: 'system.settings.mailTransportRequired',
				}
			: {}),
	};
}

function settingsProblem(error: unknown): Response {
	if (error instanceof ModuleSettingsError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The settings request failed.');
}

export interface OverviewActivityPoint {
	readonly date: string;
	readonly count: number;
}

export interface OverviewModulePoint {
	readonly id: string;
	readonly name: string;
	readonly permissions: number;
}

export interface SystemOverviewPayload {
	readonly enabledModuleCount: number;
	readonly moduleCount: number;
	readonly activity: readonly OverviewActivityPoint[];
	readonly modules: readonly OverviewModulePoint[];
}

const ACTIVITY_DAYS = 14;
const DAY_MS = 86_400_000;
const AUDIT_PAGE = 100;
/* auth.core exposes the audit trail only as a newest-first paged query, so a
   busy tenant's window is bounded by this page cap here; the precise fix is a
   count-by-day aggregate on auth.core. */
const MAX_ACTIVITY_PAGES = 50;

function utcDayKey(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

/* Last 14 days of audit events per day for the tenant, read from the auth
   runtime already available in the composition context. Events arrive
   newest-first, so paging stops as soon as one predates the window. */
function readActivity(
	auth: AuthRuntime,
	tenantId: string,
): OverviewActivityPoint[] {
	const now = new Date();
	const todayStart = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate(),
	);
	const windowStart = todayStart - (ACTIVITY_DAYS - 1) * DAY_MS;
	const keys: string[] = [];
	const counts = new Map<string, number>();
	for (let index = 0; index < ACTIVITY_DAYS; index += 1) {
		const key = utcDayKey(windowStart + index * DAY_MS);
		keys.push(key);
		counts.set(key, 0);
	}
	const service = auth.service();
	let cursor: string | null = null;
	for (let page = 0; page < MAX_ACTIVITY_PAGES; page += 1) {
		const result = service.queryAudit({ tenantId, limit: AUDIT_PAGE, cursor });
		let reachedWindowEnd = false;
		for (const event of result.events) {
			if (event.occurredAt < windowStart) {
				reachedWindowEnd = true;
				break;
			}
			const key = utcDayKey(event.occurredAt);
			const current = counts.get(key);
			if (current !== undefined) counts.set(key, current + 1);
		}
		if (reachedWindowEnd || result.nextCursor === null) break;
		cursor = result.nextCursor;
	}
	return keys.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

/* Metadata only: manifests and specifications from the workspace. Enabling or
   disabling a module stays a CLI operation with its own approval trail. */
export function createSystemRoutes(options: SystemRouteOptions) {
	const modules = defineEndpoint({
		id: 'system.modules.list',
		path: '/api/system/modules',
		methods: ['GET'],
		access: { kind: 'permission', permission: SYSTEM_PERMISSIONS.modulesRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: () => {
			try {
				return jsonResponse({
					modules: readModuleCatalog(options.workspaceRoot),
					commands: {
						enable: 'pnpm coreloom module enable <id> --apply',
						disable: 'pnpm coreloom module disable <id> --apply',
						sync: 'pnpm coreloom module sync --apply',
						grantScopes: 'pnpm coreloom auth sync-scopes --module <id> --apply',
					},
				});
			} catch (error) {
				return problemResponse(error, 'The module catalog is unavailable.');
			}
		},
	});

	/* Module names come from the workspace specs; the catalog is read once per
	   composition, which in development is once per reload. */
	let names: ReadonlyMap<
		string,
		{ readonly name: string; readonly description: string }
	> | null = null;
	const moduleName = (moduleId: string) => {
		if (!names) {
			names = new Map(
				readModuleCatalog(options.workspaceRoot).map((entry) => [
					entry.id,
					{ name: entry.name, description: entry.description },
				]),
			);
		}
		return names.get(moduleId) ?? { name: moduleId, description: '' };
	};

	const overview = defineEndpoint({
		id: 'system.overview.read',
		path: '/api/system/overview',
		methods: ['GET'],
		access: {
			kind: 'permission',
			permission: SYSTEM_PERMISSIONS.workspaceAccess,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const catalog = readModuleCatalog(options.workspaceRoot);
				const modules = catalog
					.map((entry) => ({
						id: entry.id,
						name: entry.name,
						permissions: entry.permissions.length,
					}))
					.sort(
						(a, b) =>
							b.permissions - a.permissions || a.name.localeCompare(b.name),
					);
				const payload: SystemOverviewPayload = {
					enabledModuleCount: catalog.filter((entry) => entry.enabled).length,
					moduleCount: catalog.length,
					activity: readActivity(options.auth, principal.tenantId),
					modules,
				};
				return jsonResponse(payload);
			} catch (error) {
				return problemResponse(error, 'The workspace overview is unavailable.');
			}
		},
	});

	const settingsList = defineEndpoint({
		id: 'system.settings.list',
		path: '/api/settings',
		methods: ['GET'],
		access: { kind: 'permission', permission: SYSTEM_PERMISSIONS.settingsRead },
		resolveIdentity: endpointIdentityFromContext,
		handler: ({ octane }) => {
			try {
				const principal = principalFromContext(octane)!;
				const grouped = new Map<string, SettingsEntryPayload[]>();
				for (const entry of options.settings.list(principal.tenantId)) {
					const group = grouped.get(entry.moduleId) ?? [];
					group.push(entryPayload(entry, options.auth.mailTransport));
					grouped.set(entry.moduleId, group);
				}
				const payload: SettingsModulePayload[] = [...grouped].map(
					([moduleId, settings]) => ({
						moduleId,
						...moduleName(moduleId),
						settings,
					}),
				);
				return jsonResponse({ modules: payload });
			} catch (error) {
				return settingsProblem(error);
			}
		},
	});

	const settingsUpdate = defineEndpoint({
		id: 'system.settings.update',
		path: '/api/settings/update',
		methods: ['POST'],
		access: {
			kind: 'permission',
			permission: SYSTEM_PERMISSIONS.settingsManage,
		},
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, options.auth);
			if (denial) return denial;
			try {
				const principal = principalFromContext(octane)!;
				const body = await readJsonObject(octane.request);
				const moduleId = requiredString(body, 'moduleId', { max: 128 });
				const key = requiredString(body, 'key', { max: 128 });
				const value = body.value;
				if (
					value !== null &&
					typeof value !== 'string' &&
					typeof value !== 'number' &&
					typeof value !== 'boolean'
				) {
					throw new HttpProblem(
						'INVALID_INPUT',
						'value must be a string, number, boolean, or null.',
						400,
					);
				}
				if (
					moduleId === 'auth.core' &&
					key === 'emailConfirmation' &&
					value === true &&
					!options.auth.mailTransport
				) {
					throw new HttpProblem(
						'MAIL_TRANSPORT_REQUIRED',
						MAIL_TRANSPORT_REQUIRED,
						409,
					);
				}
				options.settings.set(
					principal.tenantId,
					moduleId,
					key,
					value ?? null,
					principal.accountId,
				);
				const entry = options.settings
					.list(principal.tenantId)
					.find((item) => item.moduleId === moduleId && item.key === key);
				return jsonResponse({
					setting: entry
						? entryPayload(entry, options.auth.mailTransport)
						: null,
				});
			} catch (error) {
				return settingsProblem(error);
			}
		},
	});

	return [
		modules.serverRoute,
		overview.serverRoute,
		settingsList.serverRoute,
		settingsUpdate.serverRoute,
	] as const;
}

export const endpoints = [
	'system.modules.list',
	'system.overview.read',
	'system.settings.list',
	'system.settings.update',
] as const;
