import { parse as parseYaml } from 'yaml';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
	ModuleArtifact,
	ModuleManifest,
	ModuleReviewEvidence,
	ModuleSourceFile,
} from '@flowdular/contracts';
import { assertModuleCompatibility } from '@flowdular/kernel';
import { validators } from './validation.ts';

export const MAX_ARTIFACT_BYTES = 48 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_FILES = 4096;
export const hashBytes = (bytes: string | Uint8Array): string =>
	createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const ROOTS = new Set(['src', 'tests', 'migrations', 'translations', 'spec']);
const ROOT_FILES = new Set([
	'module.json',
	'package.json',
	'README.md',
	'CHANGELOG.md',
	'LICENSE',
	'tsconfig.json',
	'vitest.config.ts',
]);

export class ModuleDistributionError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}
export function distributionAssert(
	condition: unknown,
	code: string,
	message: string,
): asserts condition {
	if (!condition) throw new ModuleDistributionError(code, message);
}
export function safeSourcePath(path: string): boolean {
	const parts = path.split('/');
	return (
		path.length < 240 &&
		/^[a-zA-Z0-9_./@+ -]+$/.test(path) &&
		parts.every(
			(part) =>
				part &&
				part !== '.' &&
				part !== '..' &&
				!part.startsWith('.') &&
				part !== 'node_modules' &&
				part !== 'dist',
		) &&
		(parts.length === 1 ? ROOT_FILES.has(path) : ROOTS.has(parts[0]!))
	);
}
export function sourceDigest(files: readonly ModuleSourceFile[]): string {
	return hashBytes(
		JSON.stringify(
			[...files]
				.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
				.map((file) => [file.path, file.sha256]),
		),
	);
}
export async function readModuleSource(
	root: string,
): Promise<ModuleSourceFile[]> {
	const files: ModuleSourceFile[] = [];
	let size = 0;
	async function visit(directory: string, prefix: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = prefix + entry.name;
			if (!prefix && !ROOT_FILES.has(path) && !ROOTS.has(path)) continue;
			distributionAssert(
				!entry.isSymbolicLink(),
				'MODULE_SOURCE_LINK',
				`Module source contains a link: ${path}`,
			);
			if (entry.isDirectory()) {
				distributionAssert(
					!entry.name.startsWith('.') &&
						entry.name !== 'node_modules' &&
						entry.name !== 'dist',
					'MODULE_SOURCE_PATH',
					`Unexpected module directory: ${path}`,
				);
				await visit(join(directory, entry.name), path + '/');
			} else {
				distributionAssert(
					entry.isFile() && safeSourcePath(path),
					'MODULE_SOURCE_PATH',
					`Unexpected module source: ${path}`,
				);
				const stat = await lstat(join(directory, entry.name));
				distributionAssert(
					size + stat.size <= MAX_SOURCE_BYTES && files.length < MAX_FILES,
					'MODULE_SOURCE_LIMIT',
					'Module source is too large.',
				);
				const bytes = await readFile(join(directory, entry.name));
				size += bytes.length;
				files.push({
					path,
					content: bytes.toString('base64'),
					sha256: hashBytes(bytes),
				});
			}
		}
	}
	distributionAssert(
		!(await lstat(root)).isSymbolicLink(),
		'MODULE_SOURCE_LINK',
		'Module root cannot be a link.',
	);
	await visit(root, '');
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export function validateModuleArtifact(value: unknown): ModuleArtifact {
	const artifact = value as ModuleArtifact;
	distributionAssert(
		validators.moduleArtifact(artifact) &&
			artifact &&
			artifact.schemaVersion === 1 &&
			Array.isArray(artifact.files) &&
			artifact.files.length <= MAX_FILES &&
			validators.module(artifact.manifest),
		'MODULE_ARTIFACT_INVALID',
		'Invalid module artifact.',
	);
	assertModuleCompatibility(artifact.manifest);
	distributionAssert(
		artifact.manifest.platformApi,
		'MODULE_PLATFORM_REQUIRED',
		'Distributed modules must declare platformApi.',
	);
	const paths = new Set<string>();
	let size = 0;
	for (const file of artifact.files) {
		distributionAssert(
			file &&
				typeof file.path === 'string' &&
				safeSourcePath(file.path) &&
				typeof file.content === 'string' &&
				typeof file.sha256 === 'string' &&
				HASH.test(file.sha256),
			'MODULE_ARTIFACT_PATH',
			'Invalid artifact file.',
		);
		const key = file.path.toLowerCase();
		distributionAssert(
			!paths.has(key),
			'MODULE_ARTIFACT_COLLISION',
			`Duplicate file: ${file.path}`,
		);
		paths.add(key);
		const bytes = Buffer.from(file.content, 'base64');
		size += bytes.length;
		distributionAssert(
			bytes.toString('base64') === file.content &&
				hashBytes(bytes) === file.sha256 &&
				size <= MAX_SOURCE_BYTES,
			'MODULE_ARTIFACT_DIGEST',
			`Invalid content: ${file.path}`,
		);
	}
	for (const path of paths)
		for (const parent of path
			.split('/')
			.slice(0, -1)
			.map((_, i) =>
				path
					.split('/')
					.slice(0, i + 1)
					.join('/'),
			))
			distributionAssert(
				!paths.has(parent),
				'MODULE_ARTIFACT_COLLISION',
				`File/directory collision: ${path}`,
			);
	function json(path: string): Record<string, unknown> {
		const file = artifact.files.find((file) => file.path === path);
		distributionAssert(
			file,
			'MODULE_ARTIFACT_MISSING',
			`Artifact is missing ${path}.`,
		);
		return JSON.parse(
			Buffer.from(file.content, 'base64').toString('utf8'),
		) as Record<string, unknown>;
	}
	const manifest = json('module.json');
	const pkg = json('package.json');
	distributionAssert(
		JSON.stringify(manifest) === JSON.stringify(artifact.manifest) &&
			pkg.name === artifact.manifest.package &&
			pkg.version === artifact.manifest.version &&
			paths.has('spec/module.yaml'),
		'MODULE_ARTIFACT_IDENTITY',
		'Artifact identity does not match source/package/spec.',
	);
	for (const section of [
		'dependencies',
		'devDependencies',
		'peerDependencies',
		'optionalDependencies',
	]) {
		const dependencies = (pkg[section] ?? {}) as Record<string, unknown>;
		distributionAssert(
			Object.values(dependencies).every(
				(value) =>
					typeof value === 'string' && !/^(workspace:|file:|link:)/.test(value),
			),
			'MODULE_NONPORTABLE_DEPENDENCY',
			'Distributed module dependencies must resolve outside the authoring workspace.',
		);
	}
	const specFile = artifact.files.find(
		(file) => file.path === 'spec/module.yaml',
	)!;
	const spec = parseYaml(
		Buffer.from(specFile.content, 'base64').toString('utf8'),
	) as { id?: string; specVersion?: string };
	distributionAssert(
		validators.moduleSpec(spec) &&
			spec.id === artifact.manifest.id &&
			spec.specVersion === artifact.manifest.version,
		'MODULE_SPEC_INVALID',
		'Module specification is invalid or differs from the released identity.',
	);
	const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
	for (const script of ['preinstall', 'install', 'postinstall', 'prepare'])
		distributionAssert(
			!(script in scripts),
			'MODULE_INSTALL_SCRIPT',
			`Install lifecycle scripts are forbidden: ${script}`,
		);
	const review = artifact.review;
	distributionAssert(
		review &&
			review.sourceSha256 === sourceDigest(artifact.files) &&
			Array.isArray(review.findings) &&
			review.findings.length === 0 &&
			Array.isArray(review.requirements) &&
			review.requirements.length > 0 &&
			review.requirements.every(
				(item) => typeof item === 'string' && item.trim(),
			) &&
			Array.isArray(review.checks),
		'MODULE_REVIEW_INVALID',
		'Missing, stale or failing review evidence.',
	);
	for (const name of ['typecheck', 'test', 'validate'])
		distributionAssert(
			review.checks.some(
				(check) =>
					check &&
					check.name === name &&
					check.exitCode === 0 &&
					typeof check.command === 'string' &&
					check.command.trim(),
			),
			'MODULE_REVIEW_INVALID',
			`Missing passing ${name} evidence.`,
		);
	distributionAssert(
		review.checks.every((check) => check.exitCode === 0),
		'MODULE_REVIEW_INVALID',
		'Review contains a failing check.',
	);
	return artifact;
}
export async function packModule(
	root: string,
	review: ModuleReviewEvidence,
): Promise<ModuleArtifact> {
	const files = await readModuleSource(root);
	const file = files.find((file) => file.path === 'module.json');
	distributionAssert(
		file,
		'MODULE_ARTIFACT_MISSING',
		'module.json is missing.',
	);
	const manifest = JSON.parse(
		Buffer.from(file.content, 'base64').toString('utf8'),
	) as ModuleManifest;
	return validateModuleArtifact({ schemaVersion: 1, manifest, files, review });
}
