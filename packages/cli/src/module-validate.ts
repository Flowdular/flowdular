import { access, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { failure, success, type CommandEnvelope } from '@coreloom/cli-protocol';
import type {
	ModuleManifest,
	RegisteredModule,
	ValidationIssue,
} from '@coreloom/contracts';
import { createModuleRegistry } from '@coreloom/kernel';
import {
	findNamedFiles,
	validateFile,
	validators,
	type FileValidation,
} from './validation.ts';
import type { Workspace } from './workspace.ts';

interface PlatformManifest extends ModuleManifest {
	readonly platform?: {
		readonly server?: boolean;
		readonly client?: boolean;
	};
}

function issue(
	code: string,
	message: string,
	path: string,
	severity: ValidationIssue['severity'] = 'error',
): ValidationIssue {
	return { code, message, path, severity };
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function platformIssues(
	moduleRoot: string,
	manifest: PlatformManifest,
): Promise<ValidationIssue[]> {
	const issues: ValidationIssue[] = [];
	let exports: Record<string, unknown> = {};
	let packageName: unknown;
	try {
		const pkg = (await readJson(join(moduleRoot, 'package.json'))) as {
			name?: unknown;
			exports?: Record<string, unknown>;
		};
		exports = pkg.exports ?? {};
		packageName = pkg.name;
	} catch (error) {
		issues.push(
			issue(
				'PACKAGE_MANIFEST_INVALID',
				`package.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
				'package.json',
			),
		);
		return issues;
	}
	if (packageName !== manifest.package) {
		issues.push(
			issue(
				'PACKAGE_NAME_MISMATCH',
				`package.json name "${String(packageName)}" differs from module.json package "${manifest.package}".`,
				'package.json',
			),
		);
	}
	if (manifest.platform?.server === true) {
		if (!(await exists(join(moduleRoot, 'src/platform.ts')))) {
			issues.push(
				issue(
					'PLATFORM_SERVER_ENTRY_MISSING',
					'platform.server requires src/platform.ts exporting createServerComposition.',
					'src/platform.ts',
				),
			);
		}
		if (!('./platform' in exports)) {
			issues.push(
				issue(
					'PLATFORM_EXPORT_MISSING',
					'platform.server requires a "./platform" entry in package.json exports.',
					'package.json',
				),
			);
		}
	}
	if (manifest.platform?.client === true) {
		if (!(await exists(join(moduleRoot, 'src/client/index.ts')))) {
			issues.push(
				issue(
					'PLATFORM_CLIENT_ENTRY_MISSING',
					'platform.client requires src/client/index.ts exporting createClientContribution.',
					'src/client/index.ts',
				),
			);
		}
		if (!('./client' in exports)) {
			issues.push(
				issue(
					'PLATFORM_CLIENT_EXPORT_MISSING',
					'platform.client requires a "./client" entry in package.json exports.',
					'package.json',
				),
			);
		}
	}
	return issues;
}

async function specIssues(
	moduleRoot: string,
	manifest: ModuleManifest,
	specDirectory: string,
): Promise<ValidationIssue[]> {
	const specPath = join(specDirectory, 'module.yaml');
	let spec: { id?: unknown; specVersion?: unknown };
	try {
		spec = parseYaml(
			await readFile(join(moduleRoot, specPath), 'utf8'),
		) as typeof spec;
	} catch (error) {
		return [
			issue(
				'SPEC_FILE_MISSING',
				`Module specification could not be read: ${error instanceof Error ? error.message : String(error)}`,
				specPath,
				'warning',
			),
		];
	}
	const issues: ValidationIssue[] = [];
	if (spec.id !== manifest.id) {
		issues.push(
			issue(
				'SPEC_ID_MISMATCH',
				`Specification id "${String(spec.id)}" differs from module.json id "${manifest.id}".`,
				specPath,
			),
		);
	}
	if (String(spec.specVersion) !== manifest.version) {
		issues.push(
			issue(
				'SPEC_VERSION_DRIFT',
				`module.json version ${manifest.version} differs from specVersion ${String(spec.specVersion)}.`,
				specPath,
				'warning',
			),
		);
	}
	return issues;
}

async function translationIssues(
	moduleRoot: string,
	manifest: ModuleManifest,
	projectLocales: readonly string[] | undefined,
): Promise<ValidationIssue[]> {
	const issues: ValidationIssue[] = [];
	if (projectLocales) {
		for (const locale of manifest.locales) {
			if (!projectLocales.includes(locale)) {
				issues.push(
					issue(
						'LOCALE_NOT_IN_PROJECT',
						`Locale "${locale}" is not listed in coreloom.json locales.`,
						'module.json',
						'warning',
					),
				);
			}
		}
	}
	if (!manifest.capabilities.includes('translations')) return issues;
	const keySets = new Map<string, readonly string[]>();
	for (const locale of manifest.locales) {
		const path = `translations/${locale}.json`;
		if (!(await exists(join(moduleRoot, path)))) {
			issues.push(
				issue(
					'TRANSLATION_FILE_MISSING',
					`Locale "${locale}" has no ${path}.`,
					path,
				),
			);
			continue;
		}
		try {
			const bundle = await readJson(join(moduleRoot, path));
			if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
				throw new Error('Expected a JSON object.');
			}
			keySets.set(locale, Object.keys(bundle).sort());
		} catch (error) {
			issues.push(
				issue(
					'TRANSLATION_PARSE_ERROR',
					`${path} is not a JSON object: ${error instanceof Error ? error.message : String(error)}`,
					path,
				),
			);
		}
	}
	const [reference, ...others] = [...keySets.entries()];
	if (!reference) return issues;
	for (const [locale, keys] of others) {
		const missing = reference[1].filter((key) => !keys.includes(key));
		const extra = keys.filter((key) => !reference[1].includes(key));
		if (missing.length === 0 && extra.length === 0) continue;
		const detail = [
			...(missing.length > 0 ? [`missing ${missing.join(', ')}`] : []),
			...(extra.length > 0 ? [`extra ${extra.join(', ')}`] : []),
		].join('; ');
		issues.push(
			issue(
				'TRANSLATION_KEYS_MISMATCH',
				`translations/${locale}.json keys differ from translations/${reference[0]}.json: ${detail}.`,
				`translations/${locale}.json`,
			),
		);
	}
	return issues;
}

export async function moduleLayoutIssues(
	moduleRoot: string,
	manifest: PlatformManifest,
	options: {
		readonly specDirectory?: string;
		readonly projectLocales?: readonly string[];
	} = {},
): Promise<ValidationIssue[]> {
	return [
		...(await platformIssues(moduleRoot, manifest)),
		...(await specIssues(
			moduleRoot,
			manifest,
			options.specDirectory ?? 'spec',
		)),
		...(await translationIssues(moduleRoot, manifest, options.projectLocales)),
	];
}

function relativeReports(
	root: string,
	reports: readonly FileValidation[],
): FileValidation[] {
	return reports.map((report) => ({
		...report,
		file: relative(root, report.file),
	}));
}

export async function validateModules(
	workspace: Workspace,
	options: { readonly modules?: readonly string[] } = {},
): Promise<CommandEnvelope> {
	const files = (await findNamedFiles(workspace.root, 'module.json')).filter(
		(file) => file.includes('/modules/'),
	);
	const config = workspace.config as {
		specs?: { moduleDirectory?: string };
		locales?: string[];
		modules?: { enabled?: string[] };
	};
	/* A sandbox session carries manifest-only copies of the modules it depends
	   on so the registry graph resolves; file-level checks then apply only to
	   the module under construction, named here. Every manifest still feeds the
	   registry below. */
	const filter =
		options.modules && options.modules.length > 0
			? new Set(options.modules)
			: null;
	const reports: FileValidation[] = [];
	const manifests: ModuleManifest[] = [];
	for (const file of files) {
		const schema = await validateFile(file, validators.module);
		if (!schema.valid) {
			let id: string | undefined;
			try {
				id = ((await readJson(file)) as { id?: string }).id;
			} catch {
				id = undefined;
			}
			if (!filter || (id !== undefined && filter.has(id))) {
				reports.push(schema);
			}
			continue;
		}
		const manifest = (await readJson(file)) as PlatformManifest;
		manifests.push(manifest);
		if (filter && !filter.has(manifest.id)) continue;
		const issues = await moduleLayoutIssues(dirname(file), manifest, {
			specDirectory: config.specs?.moduleDirectory ?? 'spec',
			...(config.locales ? { projectLocales: config.locales } : {}),
		});
		reports.push({
			file,
			valid: issues.every((entry) => entry.severity !== 'error'),
			issues,
		});
	}
	const data = relativeReports(workspace.root, reports);
	const warnings = data.flatMap((report) =>
		report.issues
			.filter((entry) => entry.severity === 'warning')
			.map((entry) => `${report.file}: ${entry.code} ${entry.message}`),
	);
	if (!reports.every((report) => report.valid)) {
		return failure(
			'MODULE_VALIDATION_FAILED',
			'One or more module manifests are invalid.',
			{ reports: data },
		);
	}

	try {
		const registered = manifests.map(
			(manifest) => ({ manifest }) satisfies RegisteredModule,
		);
		const registry = createModuleRegistry(registered);
		const enabled = config.modules?.enabled ?? [];
		const missingEnabled = enabled.filter((id) => !registry.has(id));
		if (missingEnabled.length > 0) {
			return failure(
				'MODULE_ENABLED_MISSING',
				`Enabled modules are not registered: ${missingEnabled.join(', ')}`,
				{ reports: data, missingEnabled },
			);
		}
		return success(
			{
				valid: true,
				order: registry.modules.map((module) => module.manifest.id),
				reports: data,
			},
			{ evidence: data.map((report) => report.file), warnings },
		);
	} catch (error) {
		return failure(
			'MODULE_REGISTRY_INVALID',
			error instanceof Error ? error.message : String(error),
			{ reports: data },
		);
	}
}
