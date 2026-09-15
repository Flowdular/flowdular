import type { AuthActor } from '@flowdular/module-auth';
import {
	activeModuleIds,
	dependentsOf,
	isRequiredModule,
	type ComposedModule,
	type ModuleActivationChange,
	type ModuleActivationEntry,
} from '../domain/modules.ts';
import type { ModuleActivationRepository } from './repository.ts';

export type ModuleActivationErrorCode =
	| 'MODULE_UNKNOWN'
	| 'MODULE_REQUIRED'
	| 'MODULE_HAS_ACTIVE_DEPENDENTS'
	| 'MODULE_DEPENDENCY_INACTIVE';

export class ModuleActivationError extends Error {
	readonly code: ModuleActivationErrorCode;
	readonly status: number;
	/** The modules a refusal names: active dependents or inactive dependencies. */
	readonly modules: readonly string[];

	constructor(
		code: ModuleActivationErrorCode,
		message: string,
		status: number,
		modules: readonly string[] = [],
	) {
		super(message);
		this.name = 'ModuleActivationError';
		this.code = code;
		this.status = status;
		this.modules = modules;
	}
}

export interface ModuleActivationServiceOptions {
	readonly repository: ModuleActivationRepository;
	/** The modules the application composes; read once per call, never cached here. */
	readonly modules: () => readonly ComposedModule[];
	readonly audit?: (
		actor: AuthActor,
		change: ModuleActivationChange,
	) => Promise<void>;
	readonly now?: () => number;
	/** How long a workspace snapshot answers before it is read again. */
	readonly snapshotTtlMs?: number;
	readonly maxTenants?: number;
}

interface Snapshot {
	readonly inactive: ReadonlySet<string>;
	readonly expiresAt: number;
}

export const DEFAULT_SNAPSHOT_TTL_MS = 30_000;
export const DEFAULT_SNAPSHOT_TENANTS = 1024;

/**
 * Per-workspace activation of the modules the application composes. Every
 * composed module is active until an owner deactivates it; a required module
 * and a module another active module depends on stay active. Reads come from
 * a memoised per-tenant snapshot so a request costs no query of its own.
 */
export class ModuleActivationService {
	readonly #repository: ModuleActivationRepository;
	readonly #modules: () => readonly ComposedModule[];
	readonly #audit: ModuleActivationServiceOptions['audit'];
	readonly #now: () => number;
	readonly #ttlMs: number;
	readonly #maxTenants: number;
	readonly #snapshots = new Map<string, Promise<Snapshot>>();

	constructor(options: ModuleActivationServiceOptions) {
		this.#repository = options.repository;
		this.#modules = options.modules;
		this.#audit = options.audit;
		this.#now = options.now ?? Date.now;
		this.#ttlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
		this.#maxTenants = options.maxTenants ?? DEFAULT_SNAPSHOT_TENANTS;
	}

	/** Composed optional module ids an owner deactivated for the workspace. */
	async inactive(tenantId: string): Promise<ReadonlySet<string>> {
		const cached = this.#snapshots.get(tenantId);
		if (cached) {
			const snapshot = await cached;
			if (snapshot.expiresAt > this.#now()) return snapshot.inactive;
		}
		const loading = this.#load(tenantId);
		this.#snapshots.delete(tenantId);
		this.#snapshots.set(tenantId, loading);
		while (this.#snapshots.size > this.#maxTenants) {
			const oldest = this.#snapshots.keys().next().value;
			if (oldest === undefined) break;
			this.#snapshots.delete(oldest);
		}
		try {
			return (await loading).inactive;
		} catch (error) {
			if (this.#snapshots.get(tenantId) === loading) {
				this.#snapshots.delete(tenantId);
			}
			throw error;
		}
	}

	invalidate(tenantId: string): void {
		this.#snapshots.delete(tenantId);
	}

	async isActive(tenantId: string, moduleId: string): Promise<boolean> {
		if (isRequiredModule(moduleId)) return true;
		return !(await this.inactive(tenantId)).has(moduleId);
	}

	async activeIds(tenantId: string): Promise<readonly string[]> {
		return activeModuleIds(this.#modules(), await this.inactive(tenantId));
	}

	async list(tenantId: string): Promise<readonly ModuleActivationEntry[]> {
		const modules = this.#modules();
		const inactive = await this.inactive(tenantId);
		return modules.map((module) => this.#entry(modules, module, inactive));
	}

	async activate(
		actor: AuthActor,
		moduleId: string,
	): Promise<ModuleActivationEntry> {
		const modules = this.#modules();
		const module = this.#composed(modules, moduleId);
		const inactive = await this.inactive(actor.tenantId);
		if (!inactive.has(moduleId)) {
			return this.#entry(modules, module, inactive);
		}
		const missing = module.dependencies.filter(
			(dependency) => !isRequiredModule(dependency) && inactive.has(dependency),
		);
		if (missing.length > 0) {
			throw new ModuleActivationError(
				'MODULE_DEPENDENCY_INACTIVE',
				`${moduleId} needs ${missing.join(', ')} active first.`,
				409,
				missing,
			);
		}
		return this.#write(actor, modules, module, true);
	}

	async deactivate(
		actor: AuthActor,
		moduleId: string,
	): Promise<ModuleActivationEntry> {
		const modules = this.#modules();
		const module = this.#composed(modules, moduleId);
		if (isRequiredModule(moduleId)) {
			throw new ModuleActivationError(
				'MODULE_REQUIRED',
				`${moduleId} is required by every workspace and cannot be deactivated.`,
				409,
			);
		}
		const inactive = await this.inactive(actor.tenantId);
		if (inactive.has(moduleId)) {
			return this.#entry(modules, module, inactive);
		}
		const dependents = dependentsOf(modules, moduleId).filter(
			(dependent) => isRequiredModule(dependent) || !inactive.has(dependent),
		);
		if (dependents.length > 0) {
			throw new ModuleActivationError(
				'MODULE_HAS_ACTIVE_DEPENDENTS',
				`${moduleId} is a dependency of ${dependents.join(', ')}; deactivate those first.`,
				409,
				dependents,
			);
		}
		return this.#write(actor, modules, module, false);
	}

	#composed(
		modules: readonly ComposedModule[],
		moduleId: string,
	): ComposedModule {
		const module = modules.find((candidate) => candidate.id === moduleId);
		if (!module) {
			throw new ModuleActivationError(
				'MODULE_UNKNOWN',
				`${moduleId} is not composed in this application.`,
				404,
			);
		}
		return module;
	}

	#entry(
		modules: readonly ComposedModule[],
		module: ComposedModule,
		inactive: ReadonlySet<string>,
	): ModuleActivationEntry {
		const optional = !isRequiredModule(module.id);
		return {
			id: module.id,
			version: module.version,
			active: !optional || !inactive.has(module.id),
			optional,
			dependents: dependentsOf(modules, module.id),
		};
	}

	async #write(
		actor: AuthActor,
		modules: readonly ComposedModule[],
		module: ComposedModule,
		active: boolean,
	): Promise<ModuleActivationEntry> {
		await this.#repository.set({
			tenantId: actor.tenantId,
			moduleId: module.id,
			active,
			changedBy: actor.accountId,
			changedAt: this.#now(),
		});
		this.invalidate(actor.tenantId);
		await this.#audit?.(actor, { moduleId: module.id, active });
		return this.#entry(modules, module, await this.inactive(actor.tenantId));
	}

	async #load(tenantId: string): Promise<Snapshot> {
		const composed = new Set(this.#modules().map((module) => module.id));
		const inactive = new Set<string>();
		for (const record of await this.#repository.list(tenantId)) {
			if (
				!record.active &&
				composed.has(record.moduleId) &&
				!isRequiredModule(record.moduleId)
			) {
				inactive.add(record.moduleId);
			}
		}
		return { inactive, expiresAt: this.#now() + this.#ttlMs };
	}
}
