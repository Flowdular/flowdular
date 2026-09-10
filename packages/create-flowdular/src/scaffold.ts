import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { checkProjectName } from './name.ts';
import {
	generateSecrets,
	renderEnvironmentFile,
	type GeneratedSecrets,
} from './secrets.ts';
import { copyTemplate, templateRoot } from './template.ts';

export class ScaffoldError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ScaffoldError';
	}
}

export interface ScaffoldRequest {
	readonly cwd: string;
	readonly target: string;
	readonly template: string;
	readonly force: boolean;
	/** Injected by tests; production always generates fresh keys. */
	readonly secrets?: GeneratedSecrets;
}

export interface ScaffoldResult {
	readonly directory: string;
	readonly name: string;
	readonly files: number;
}

async function directoryEntries(path: string): Promise<readonly string[]> {
	try {
		return await readdir(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
}

async function assertTemplateExists(path: string, name: string): Promise<void> {
	try {
		if ((await stat(path)).isDirectory()) return;
	} catch {
		/* Reported below as a missing template. */
	}
	throw new ScaffoldError(`"${name}" is not a template this version ships.`);
}

async function rewritePackageName(
	directory: string,
	name: string,
): Promise<void> {
	const path = join(directory, 'package.json');
	const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<
		string,
		unknown
	>;
	manifest.name = name;
	await writeFile(path, JSON.stringify(manifest, undefined, '\t') + '\n');
}

export async function scaffold(
	request: ScaffoldRequest,
): Promise<ScaffoldResult> {
	const directory = resolve(request.cwd, request.target);
	const name = basename(directory);
	const check = checkProjectName(name);
	if (!check.valid) {
		throw new ScaffoldError(
			`"${name}" is not a valid npm package name: ${check.reason}.`,
		);
	}
	const template = templateRoot(request.template);
	await assertTemplateExists(template, request.template);
	const existing = await directoryEntries(directory);
	if (existing.length > 0 && !request.force) {
		throw new ScaffoldError(
			`${directory} is not empty. Pass --force to scaffold into it anyway.`,
		);
	}
	const files = await copyTemplate(template, directory);
	await rewritePackageName(directory, name);
	await writeFile(
		join(directory, '.env'),
		renderEnvironmentFile(request.secrets ?? generateSecrets()),
	);
	return { directory, name, files: files + 1 };
}
