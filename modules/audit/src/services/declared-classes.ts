import type {
	DataClassDeclaration,
	DataClassModuleEntry,
	PlatformDataClassRegistry,
} from '@flowdular/kernel';

export interface DeclaredDataClass {
	readonly moduleId: string;
	readonly classId: string;
	readonly declaration: DataClassDeclaration;
}

/**
 * The platform registry as audit.core reads it: the class id to owner index
 * the sweep and the export resolve against. The index is rebuilt only when the
 * registry answers a different snapshot, and a sealed registry always answers
 * the same one, so a lookup costs an identity comparison and a map read rather
 * than a walk over every module.
 */
export class DeclaredDataClasses {
	readonly #registry: PlatformDataClassRegistry;
	#snapshot: readonly DataClassModuleEntry[] | null = null;
	#index = new Map<string, DeclaredDataClass>();

	constructor(registry: PlatformDataClassRegistry) {
		this.#registry = registry;
	}

	/** Every composed module, in composition order, including those holding none. */
	modules(): readonly DataClassModuleEntry[] {
		return this.#current();
	}

	/** Every declared class, flattened, in declaration order. */
	all(): readonly DeclaredDataClass[] {
		this.#current();
		return [...this.#index.values()];
	}

	/** The owner of one class, or null when no composed module declared it. */
	resolve(classId: string): DeclaredDataClass | null {
		this.#current();
		return this.#index.get(classId) ?? null;
	}

	#current(): readonly DataClassModuleEntry[] {
		const modules = this.#registry.list();
		if (modules === this.#snapshot) return modules;
		const index = new Map<string, DeclaredDataClass>();
		for (const entry of modules) {
			for (const declaration of entry.classes) {
				const classId = `${entry.moduleId}.${declaration.key}`;
				index.set(classId, {
					moduleId: entry.moduleId,
					classId,
					declaration,
				});
			}
		}
		this.#index = index;
		this.#snapshot = modules;
		return modules;
	}
}
