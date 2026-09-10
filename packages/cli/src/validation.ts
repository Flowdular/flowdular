import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import Ajv2020, {
	type ErrorObject,
	type ValidateFunction,
} from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import {
	blueprintSchema,
	cliExtensionSchema,
	moduleSchema,
	moduleCatalogSchema,
	moduleArtifactSchema,
	moduleSpecSchema,
	platformSpecSchema,
	projectSchema,
	type ValidationIssue,
} from '@flowdular/contracts';

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = {
	application: ajv.compile(projectSchema.properties.application),
	web: ajv.compile(projectSchema.properties.web),
	project: ajv.compile(projectSchema),
	module: ajv.compile(moduleSchema),
	moduleCatalog: ajv.compile(moduleCatalogSchema),
	moduleArtifact: ajv.compile(moduleArtifactSchema),
	moduleSpec: ajv.compile(moduleSpecSchema),
	blueprint: ajv.compile(blueprintSchema),
	cliExtension: ajv.compile(cliExtensionSchema),
	platformSpec: ajv.compile(platformSpecSchema),
};

export interface FileValidation {
	readonly file: string;
	readonly valid: boolean;
	readonly issues: readonly ValidationIssue[];
}

function issuesFrom(
	errors: ErrorObject[] | null | undefined,
): ValidationIssue[] {
	return (errors ?? []).map((error) => ({
		code: `SCHEMA_${error.keyword.toUpperCase()}`,
		message: error.message ?? 'Schema validation failed.',
		path: error.instancePath || '/',
		severity: 'error' as const,
	}));
}

async function parseFile(path: string): Promise<unknown> {
	const source = await readFile(path, 'utf8');
	return path.endsWith('.yaml') || path.endsWith('.yml')
		? parseYaml(source)
		: JSON.parse(source);
}

export async function validateFile(
	path: string,
	validator: ValidateFunction,
): Promise<FileValidation> {
	try {
		const value = await parseFile(path);
		const valid = validator(value);
		return { file: path, valid, issues: issuesFrom(validator.errors) };
	} catch (error) {
		return {
			file: path,
			valid: false,
			issues: [
				{
					code: 'PARSE_ERROR',
					message: error instanceof Error ? error.message : String(error),
					severity: 'error',
				},
			],
		};
	}
}

/* Dependencies, build output, and tool state are never workspace sources.
   Sandbox session workspaces live under .flowdular and must not register as
   modules of the host workspace. Other dot directories such as .ai hold
   blueprints and are searched. */
const SKIPPED_DIRECTORIES = new Set([
	'.git',
	'.flowdular',
	'.coreloom',
	'node_modules',
	'dist',
]);

export async function findNamedFiles(
	root: string,
	name: string,
): Promise<string[]> {
	const matches: string[] = [];
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.name === name) matches.push(path);
		}
	}
	await visit(root);
	return matches.sort();
}

/* Platform specifications are the top-level YAML files of the configured
   specs root; nested directories belong to other tooling. */
export async function listPlatformSpecs(root: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	return entries
		.filter((name) => /\.ya?ml$/.test(name))
		.sort()
		.map((name) => join(root, name));
}

const blueprintFiles = [
	'README.md',
	'input.schema.json',
	'plan.schema.json',
	'spec-requirements.yaml',
	'allowed-paths.yaml',
	'required-files.yaml',
	'steps.yaml',
	'gates.yaml',
] as const;

export async function validateBlueprint(path: string): Promise<FileValidation> {
	const report = await validateFile(path, validators.blueprint);
	const directory = dirname(path);
	const entries = new Set(
		(await readdir(directory)).filter((name) => basename(name) === name),
	);
	const missing = blueprintFiles.filter((name) => !entries.has(name));
	if (missing.length === 0) return report;
	const issues = [
		...report.issues,
		...missing.map((name) => ({
			code: 'BLUEPRINT_FILE_MISSING',
			message: `Required blueprint file is missing: ${name}`,
			path: relative(process.cwd(), join(directory, name)),
			severity: 'error' as const,
		})),
	];
	return { ...report, valid: false, issues };
}

export { validators };
