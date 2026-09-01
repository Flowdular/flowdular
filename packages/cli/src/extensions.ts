import { readFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
	ModuleCliCommand,
	ModuleCliCommandDescriptor,
	ModuleCliCatalog,
	ModuleCliExtension,
} from '@coreloom/cli-protocol';
import type { ModuleManifest } from '@coreloom/contracts';
import { findNamedFiles, validateFile, validators } from './validation.ts';
import { resolveExistingInside, type Workspace } from './workspace.ts';

const reservedGroups = new Set([
	'help',
	'doctor',
	'capability',
	'spec',
	'blueprint',
	'module',
	'setup',
]);

export interface LoadedCliCommand {
	readonly moduleId: string;
	readonly moduleRoot: string;
	readonly entry: string;
	readonly command: ModuleCliCommandDescriptor;
}

export function validateCliCatalog(
	catalog: ModuleCliCatalog,
	manifest: ModuleManifest,
): void {
	if (catalog.protocolVersion !== 1)
		throw new Error('Unsupported CLI extension protocol.');
	if (catalog.moduleId !== manifest.id) {
		throw new Error(
			`CLI catalog module id "${catalog.moduleId}" does not match "${manifest.id}".`,
		);
	}
	const namespace = manifest.id.split('.')[0];
	if (!namespace)
		throw new Error(`Module "${manifest.id}" has no CLI namespace.`);
	const paths = new Set<string>();
	const capabilities = new Set<string>();
	for (const command of catalog.commands) {
		if (
			command.path.length < 2 ||
			command.path.some((part) => !/^[a-z][a-z0-9-]*$/.test(part))
		) {
			throw new Error(
				`Module "${manifest.id}" declares an invalid CLI command path.`,
			);
		}
		if (command.path[0] !== namespace || reservedGroups.has(command.path[0])) {
			throw new Error(
				`Module "${manifest.id}" must keep CLI commands inside "${namespace}".`,
			);
		}
		if (!command.capability.id.startsWith(`${namespace}.`)) {
			throw new Error(
				`Capability "${command.capability.id}" must use the "${namespace}." namespace.`,
			);
		}
		const path = command.path.join(' ');
		if (paths.has(path))
			throw new Error(`Duplicate module CLI command: ${path}`);
		if (capabilities.has(command.capability.id)) {
			throw new Error(
				`Duplicate module CLI capability: ${command.capability.id}`,
			);
		}
		paths.add(path);
		capabilities.add(command.capability.id);
	}
}

function commandKey(command: ModuleCliCommandDescriptor): string {
	return JSON.stringify({ path: command.path, capability: command.capability });
}

export async function loadCliCommand(
	loaded: LoadedCliCommand,
): Promise<ModuleCliCommand> {
	const imported = (await import(pathToFileURL(loaded.entry).href)) as {
		default?: ModuleCliExtension;
		cliExtension?: ModuleCliExtension;
	};
	const extension = imported.default ?? imported.cliExtension;
	if (!extension) {
		throw new Error(
			`CLI extension ${relative(loaded.moduleRoot, loaded.entry)} has no default or cliExtension export.`,
		);
	}
	if (
		extension.protocolVersion !== 1 ||
		extension.moduleId !== loaded.moduleId
	) {
		throw new Error(
			`CLI implementation identity does not match module "${loaded.moduleId}".`,
		);
	}
	const runtimeCommand = extension.commands.find(
		(command) => command.path.join(' ') === loaded.command.path.join(' '),
	);
	if (
		!runtimeCommand ||
		commandKey(runtimeCommand) !== commandKey(loaded.command)
	) {
		throw new Error(
			`CLI implementation for "${loaded.command.path.join(' ')}" does not match its catalog.`,
		);
	}
	return runtimeCommand;
}

export async function loadCliExtensions(
	workspace: Workspace,
): Promise<readonly LoadedCliCommand[]> {
	const enabled = new Set(
		(workspace.config.modules as { enabled?: string[] } | undefined)?.enabled ??
			[],
	);
	const manifests = (
		await findNamedFiles(workspace.root, 'module.json')
	).filter((path) => path.includes('/modules/'));
	const loaded: LoadedCliCommand[] = [];
	for (const manifestPath of manifests) {
		const manifest = JSON.parse(
			await readFile(manifestPath, 'utf8'),
		) as ModuleManifest;
		if (!enabled.has(manifest.id) || !manifest.cli) continue;
		const moduleRoot = dirname(manifestPath);
		const entry = await resolveExistingInside(moduleRoot, manifest.cli.entry);
		const catalogPath = await resolveExistingInside(
			moduleRoot,
			manifest.cli.catalog,
		);
		const report = await validateFile(catalogPath, validators.cliExtension);
		if (!report.valid) {
			throw new Error(
				`CLI catalog ${relative(workspace.root, catalogPath)} is invalid: ${report.issues.map((issue) => issue.message).join('; ')}`,
			);
		}
		const catalog = JSON.parse(
			await readFile(catalogPath, 'utf8'),
		) as ModuleCliCatalog;
		validateCliCatalog(catalog, manifest);
		for (const command of catalog.commands) {
			loaded.push({ moduleId: manifest.id, moduleRoot, entry, command });
		}
	}
	const paths = new Set<string>();
	const capabilities = new Set<string>();
	for (const entry of loaded) {
		const path = entry.command.path.join(' ');
		if (paths.has(path)) throw new Error(`CLI command collision: ${path}`);
		if (capabilities.has(entry.command.capability.id)) {
			throw new Error(
				`CLI capability collision: ${entry.command.capability.id}`,
			);
		}
		paths.add(path);
		capabilities.add(entry.command.capability.id);
	}
	return loaded;
}
