import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { findModuleManifests } from '@flowdular/kernel/module-manifests';
import { parse as parseYaml } from 'yaml';

export interface ModuleCatalogEntry {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly version: string;
	readonly specVersion: string | null;
	readonly capabilities: readonly string[];
	readonly permissions: readonly {
		readonly id: string;
		readonly description: string;
	}[];
	readonly platform: { readonly server: boolean; readonly client: boolean };
	readonly enabled: boolean;
	readonly directory: string;
	/** Declared module dependencies, by id. */
	readonly dependencies: readonly string[];
	readonly provides: readonly string[];
	/** Capability ids the module requires, optional requirements excluded. */
	readonly requires: readonly string[];
}

interface Manifest {
	id?: unknown;
	version?: unknown;
	capabilities?: unknown;
	platform?: { server?: unknown; client?: unknown };
	dependencies?: { id?: unknown }[];
	provides?: unknown;
	requires?: { id?: unknown; optional?: unknown }[];
}

interface Spec {
	name?: unknown;
	description?: unknown;
	specVersion?: unknown;
	permissions?: { id?: unknown; description?: unknown }[];
}

function strings(value: unknown): readonly string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string')
		: [];
}

function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as T;
	} catch {
		return null;
	}
}

/* The workspace's module manifests and specs are the only source of module
   display names and versions; nothing in the composition carries them. They
   are found where the CLI finds them when it composes the application, so a
   module @flowdular/sdk ships is listed beside the workspace's own. The
   result is metadata for administration screens, never module code. */
export function readModuleCatalog(
	workspaceRoot: string,
): readonly ModuleCatalogEntry[] {
	const project = readJson<{
		modules?: { enabled?: unknown; roots?: unknown };
	}>(join(workspaceRoot, 'flowdular.json'));
	const enabled = new Set(strings(project?.modules?.enabled));
	let manifests: readonly string[];
	try {
		manifests = findModuleManifests(workspaceRoot, project?.modules?.roots);
	} catch {
		/* A workspace the CLI refuses to compose lists nothing rather than
		   failing the activation reads that depend on this catalog. */
		return [];
	}
	const entries: ModuleCatalogEntry[] = [];
	for (const path of manifests) {
		const manifest = readJson<Manifest>(path);
		if (!manifest || typeof manifest.id !== 'string') continue;
		const moduleRoot = dirname(path);
		let spec: Spec | null = null;
		try {
			spec = parseYaml(
				readFileSync(join(moduleRoot, 'spec/module.yaml'), 'utf8'),
			) as Spec;
		} catch {
			spec = null;
		}
		entries.push({
			id: manifest.id,
			name: typeof spec?.name === 'string' ? spec.name : manifest.id,
			description:
				typeof spec?.description === 'string' ? spec.description : '',
			version: typeof manifest.version === 'string' ? manifest.version : '',
			specVersion:
				typeof spec?.specVersion === 'string' ? spec.specVersion : null,
			capabilities: strings(manifest.capabilities),
			permissions: (spec?.permissions ?? []).flatMap((permission) =>
				typeof permission.id === 'string'
					? [
							{
								id: permission.id,
								description:
									typeof permission.description === 'string'
										? permission.description
										: '',
							},
						]
					: [],
			),
			platform: {
				server: manifest.platform?.server === true,
				client: manifest.platform?.client === true,
			},
			enabled: enabled.has(manifest.id),
			directory: basename(moduleRoot),
			dependencies: strings(
				(Array.isArray(manifest.dependencies) ? manifest.dependencies : []).map(
					(dependency) => dependency?.id,
				),
			),
			provides: strings(manifest.provides),
			requires: strings(
				(Array.isArray(manifest.requires) ? manifest.requires : [])
					.filter((requirement) => requirement?.optional !== true)
					.map((requirement) => requirement?.id),
			),
		});
	}
	return entries.sort((left, right) =>
		left.directory < right.directory
			? -1
			: left.directory > right.directory
				? 1
				: 0,
	);
}
