/* An evaluation case is a frozen specification plus the checks its output must
   satisfy. The specification is fixed on purpose: the suite measures the skills
   that implement it, so a case whose input moves measures nothing.

   Approval is the operator's, never the runner's. A case carries the hash of
   the text its owner approved, and the runner replays that approval only while
   the hash still matches the file. Editing a fixture specification therefore
   invalidates its own case rather than quietly changing what is measured. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hashSpec } from '../server/spec.ts';
import { CHECK_IDS, type CheckId } from './checks.ts';

export interface EvalApproval {
	readonly specHash: string | null;
	readonly approvedBy: string | null;
	readonly approvedAt: string | null;
}

export interface EvalCase {
	readonly id: string;
	readonly title: string;
	readonly moduleId: string;
	readonly directory: string;
	readonly kind: 'new-module' | 'edit-module';
	readonly blueprint: string;
	readonly role: string;
	readonly brief: string;
	readonly maxTurns: number;
	readonly gates: readonly string[];
	readonly checks: readonly CheckId[];
	readonly approval: EvalApproval;
	/* The case directory and the exact specification text it froze. */
	readonly root: string;
	readonly spec: string;
}

export type ApprovalState = 'approved' | 'unapproved' | 'stale';

/* Parameter properties are not erasable syntax, and the bin runs this source
   through Node's type stripping, so the field is assigned in the body. */
export class EvalCaseError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = 'EvalCaseError';
		this.code = code;
	}
}

const CASE_ID = /^[a-z][a-z0-9-]*$/;
const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

function requireString(
	value: unknown,
	field: string,
	pattern?: RegExp,
): string {
	if (typeof value !== 'string' || value.trim().length === 0)
		throw new EvalCaseError('CASE_FIELD_MISSING', `${field} must be a string.`);
	if (pattern && !pattern.test(value))
		throw new EvalCaseError(
			'CASE_FIELD_INVALID',
			`${field} is not a valid ${field}: ${value}`,
		);
	return value;
}

function readApproval(value: unknown): EvalApproval {
	const source = (value ?? {}) as Record<string, unknown>;
	const optional = (field: string): string | null => {
		const entry = source[field];
		if (entry === null || entry === undefined) return null;
		if (typeof entry !== 'string')
			throw new EvalCaseError(
				'CASE_FIELD_INVALID',
				`approval.${field} must be a string or null.`,
			);
		return entry;
	};
	return {
		specHash: optional('specHash'),
		approvedBy: optional('approvedBy'),
		approvedAt: optional('approvedAt'),
	};
}

/** Reads one case directory: its manifest and the specification it freezes. */
export async function loadCase(root: string): Promise<EvalCase> {
	const manifest = JSON.parse(
		await readFile(join(root, 'case.json'), 'utf8'),
	) as Record<string, unknown>;
	const spec = await readFile(join(root, 'spec', 'module.yaml'), 'utf8');
	const checks = (manifest.checks ?? []) as unknown[];
	for (const check of checks)
		if (typeof check !== 'string' || !CHECK_IDS.includes(check as CheckId))
			throw new EvalCaseError(
				'CASE_CHECK_UNKNOWN',
				`${String(check)} is not a check this suite defines. Known checks: ${CHECK_IDS.join(', ')}.`,
			);
	const maxTurns = manifest.maxTurns;
	if (typeof maxTurns !== 'number' || maxTurns < 1 || maxTurns > 40)
		throw new EvalCaseError(
			'CASE_FIELD_INVALID',
			'maxTurns must be a number from 1 to 40.',
		);
	return {
		id: requireString(manifest.id, 'id', CASE_ID),
		title: requireString(manifest.title, 'title'),
		moduleId: requireString(manifest.moduleId, 'moduleId', MODULE_ID),
		directory: requireString(manifest.directory, 'directory'),
		kind: manifest.kind === 'edit-module' ? 'edit-module' : 'new-module',
		blueprint: requireString(manifest.blueprint, 'blueprint'),
		role: requireString(manifest.role, 'role'),
		brief: requireString(manifest.brief, 'brief'),
		maxTurns,
		gates: ((manifest.gates ?? []) as string[]).map(String),
		checks: checks as CheckId[],
		approval: readApproval(manifest.approval),
		root,
		spec,
	};
}

/** Every case directory under the suite root, in a stable order. */
export async function loadCases(suiteRoot: string): Promise<EvalCase[]> {
	const entries = await readdir(join(suiteRoot, 'cases'), {
		withFileTypes: true,
	});
	const cases: EvalCase[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
		if (entry.isDirectory())
			cases.push(await loadCase(join(suiteRoot, 'cases', entry.name)));
	return cases;
}

/**
 * Whether the operator's recorded approval still belongs to the frozen text.
 * `stale` means the specification was edited after it was approved, which
 * re-opens the gate exactly as it does for a live session.
 */
export function approvalState(evaluation: EvalCase): ApprovalState {
	if (!evaluation.approval.specHash) return 'unapproved';
	return evaluation.approval.specHash === hashSpec(evaluation.spec)
		? 'approved'
		: 'stale';
}
