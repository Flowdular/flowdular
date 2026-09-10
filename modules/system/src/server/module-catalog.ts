import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
}

interface Manifest {
	id?: unknown;
	version?: unknown;
	capabilities?: unknown;
	platform?: { server?: unknown; client?: unknown };
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
   display names and versions; nothing in the composition carries them. The
   result is metadata for administration screens, never module code. */
export function readModuleCatalog(
	workspaceRoot: string,
): readonly ModuleCatalogEntry[] {
	const enabled = new Set(
		strings(
			readJson<{ modules?: { enabled?: unknown } }>(
				join(workspaceRoot, 'flowdular.json'),
			)?.modules?.enabled,
		),
	);
	const modulesRoot = join(workspaceRoot, 'modules');
	let directories: string[];
	try {
		directories = readdirSync(modulesRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
	const entries: ModuleCatalogEntry[] = [];
	for (const directory of directories) {
		const manifest = readJson<Manifest>(
			join(modulesRoot, directory, 'module.json'),
		);
		if (!manifest || typeof manifest.id !== 'string') continue;
		let spec: Spec | null = null;
		try {
			spec = parseYaml(
				readFileSync(join(modulesRoot, directory, 'spec/module.yaml'), 'utf8'),
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
			directory,
		});
	}
	return entries;
}
