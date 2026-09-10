import { createHash } from 'node:crypto';
import {
	cp,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { referenceSource } from './reference.ts';
import {
	basePathOf,
	modulePathOf,
	type SessionModule,
	type SessionPaths,
} from './sessions.ts';

const CHECKS = [
	'correctness',
	'security',
	'compatibility',
	'lifecycle',
	'tests',
	'ui',
] as const;
const IGNORED = new Set(['node_modules', 'dist', '.turbo', '.git']);

/* Hash every deliverable byte, including tests, specs, config and deletions.
   Files are read one at a time; no diff truncation or mtime approximation. */
export async function moduleReviewRevision(root: string): Promise<string> {
	const hash = createHash('sha256');
	async function walk(directory: string, prefix: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (IGNORED.has(entry.name)) continue;
			const name = `${prefix}${entry.name}`;
			if (entry.isDirectory())
				await walk(join(directory, entry.name), `${name}/`);
			else if (entry.isFile()) {
				const bytes = await readFile(join(directory, entry.name));
				hash.update(JSON.stringify([name, bytes.length]));
				hash.update(bytes);
			} else {
				throw new Error(`Unsupported review entry: ${name}`);
			}
		}
	}
	await walk(root, '');
	return hash.digest('hex');
}

function reportFrom(text: string): Record<string, unknown> | null {
	if (text.length > 32_000) return null;
	const blocks = [...text.matchAll(/```auto-review\s*\n([\s\S]*?)\n```/g)];
	if (blocks.length !== 1) return null;
	try {
		const report = JSON.parse(blocks[0]![1]!);
		if (
			!report ||
			report.verdict !== 'pass' ||
			!Array.isArray(report.findings) ||
			report.findings.length !== 0
		)
			return null;
		if (
			!report.checks ||
			!CHECKS.every(
				(key) =>
					typeof report.checks[key] === 'string' &&
					report.checks[key].trim().length >= 20 &&
					report.checks[key].length <= 4_000,
			)
		)
			return null;
		return report;
	} catch {
		return null;
	}
}

function recordPath(paths: SessionPaths, module: SessionModule): string {
	const key = createHash('sha256').update(module.directory).digest('hex');
	return join(paths.root, 'auto-reviews', `${key}.json`);
}

export async function invalidateAutoReview(
	paths: SessionPaths,
	module: SessionModule,
): Promise<void> {
	await rm(recordPath(paths, module), { force: true });
}

/* Give a review turn its original files inside its readable workspace. Old
   sessions also receive the newly installed skill without rebuilding drafts. */
export async function prepareAutoReview(
	workspaceRoot: string,
	paths: SessionPaths,
	module: SessionModule,
): Promise<void> {
	const baseline = join(paths.workspace, 'reference', 'auto-review-base');
	await rm(baseline, { recursive: true, force: true });
	await cp(basePathOf(paths, module.directory), baseline, {
		recursive: true,
		filter: (source) => !IGNORED.has(basename(source)),
	});
	const skill = join(paths.workspace, 'reference', 'skills', 'auto-review');
	await mkdir(skill, { recursive: true });
	await cp(
		await referenceSource(workspaceRoot, '.ai/skills/auto-review/SKILL.md'),
		join(skill, 'SKILL.md'),
	);
}

/* Only the orchestrator calls this after a read-only auto-review turn. This
   evidence lives outside the agent workspace and never travels with a module.
   It records a model's assessment, not proof of semantic correctness. */
export async function recordAutoReview(
	paths: SessionPaths,
	module: SessionModule,
	before: string,
	closing: string,
): Promise<boolean> {
	const path = recordPath(paths, module);
	await rm(path, { force: true });
	const report = reportFrom(closing);
	if (
		!report ||
		before !==
			(await moduleReviewRevision(modulePathOf(paths, module.directory)))
	)
		return false;
	await mkdir(join(paths.root, 'auto-reviews'), { recursive: true });
	const temporary = `${path}.tmp`;
	await writeFile(
		temporary,
		JSON.stringify({
			revision: before,
			module: module.id,
			reviewedAt: Date.now(),
			closing,
		}),
	);
	await rename(temporary, path);
	return true;
}

export async function inspectAutoReview(
	paths: SessionPaths,
	module: SessionModule,
): Promise<{ passed: boolean; output: string }> {
	try {
		const record = JSON.parse(
			await readFile(recordPath(paths, module), 'utf8'),
		);
		if (
			record &&
			record.module === module.id &&
			typeof record.closing === 'string' &&
			reportFrom(record.closing) &&
			record.revision ===
				(await moduleReviewRevision(modulePathOf(paths, module.directory)))
		) {
			return {
				passed: true,
				output: `Auto-review matches ${record.revision}. Deterministic gates are checked separately.`,
			};
		}
	} catch (error) {
		if (
			!(error instanceof SyntaxError) &&
			(error as NodeJS.ErrnoException).code !== 'ENOENT'
		)
			throw error;
	}
	return {
		passed: false,
		output:
			'Run $auto-review for this module. Read the complete change and its tests, report concrete evidence for every required check and all findings. Eject requires a passing review of the current files and all deterministic gates. If defects need fixes, hand off to the owning implementation skill; do not edit in the review turn.',
	};
}
