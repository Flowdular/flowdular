import { matchesGlob } from 'node:path';
import type { AgentRoleDefinition } from '@flowdular/coding-agent';
import type { GateIssue, GateResult } from './gates.ts';

/* One thing a failed gate reported, placed at the module file its fix goes
   in. A gate that named no file is one failure without a path. */
export interface GateFailure {
	readonly gate: GateResult;
	/* The error as the gate reported it; absent for a location read from plain
	   output and for a gate that named nothing. */
	readonly issue?: GateIssue;
	readonly module: string;
	readonly path: string | null;
	/* The role whose write paths cover the path, or null when the gate named
	   no file in the session or no single role owns it. */
	readonly owner: string | null;
}

export interface GateRepair {
	readonly role: string;
	readonly module: string;
	/* What this turn is sent to fix. */
	readonly assigned: readonly GateFailure[];
	/* What another role, or this role in another module, fixes in a later
	   repair turn: the gates run again after this one. */
	readonly deferred: readonly GateFailure[];
}

/* Where the fix for an error goes when it is not the file the error names.
   A missing translation key is reported at the client file that uses it;
   what is missing is its entry in the locale bundles. */
const FIX_PATHS: Readonly<Record<string, string>> = {
	TRANSLATION_KEY_MISSING: 'translations/',
};

/* Among the roles that may write a path (tests/**, package.json and
   src/client/** have several), the one that owns that kind of file. Only a
   role that may write the path is ever chosen, so this decides ties and
   never grants a path. */
function preferredRole(path: string): string {
	if (path.startsWith('src/client/')) return 'frontend-engineer';
	if (path.startsWith('spec/') || path.startsWith('translations/'))
		return 'business-manager';
	if (path.startsWith('src/agent/')) return 'agentic-engineer';
	return 'backend-engineer';
}

export function mayWrite(role: AgentRoleDefinition, path: string): boolean {
	return role.allowedPaths.some((pattern) => matchesGlob(path, pattern));
}

export function ownerOf(
	path: string,
	roles: readonly AgentRoleDefinition[],
): string | null {
	const candidates = roles.filter((role) => mayWrite(role, path));
	const preferred = preferredRole(path);
	return (
		(
			candidates.find((role) => role.id === preferred) ??
			(candidates.length === 1 ? candidates[0] : undefined)
		)?.id ?? null
	);
}

/* Where a validator error points: its own path when that is a module file,
   otherwise the reported file itself. A path that starts with a slash is a
   JSON pointer into the reported file (`/entities/0/fields/1`). The CLI
   reports files relative to the workspace, so a pointer into a file outside
   a draft module (`reference/...`) names no module file. */
function placeIssue(
	file: unknown,
	path: unknown,
	module: string,
): { readonly path: string | null; readonly module: string } {
	const report =
		typeof file === 'string'
			? /^modules\/([a-z0-9-]+)\/(.+)$/.exec(file)
			: null;
	const target = report?.[1] ?? module;
	if (typeof path === 'string' && path && !path.startsWith('/'))
		return { path, module: target };
	return { path: report?.[2] ?? null, module: target };
}

interface Location {
	/* null when the gate named no module file for this error. */
	readonly path: string | null;
	readonly module: string;
	readonly code?: string;
	readonly issue?: GateIssue;
}

/* Read diagnostic locations, never instructions embedded in output. */
function locations(gate: GateResult, module: string): Location[] {
	/* A validator's errors were read from its own output before the cut that
	   can split the envelope below. */
	if (gate.issues)
		return gate.issues.map((issue) => ({
			...placeIssue(issue.file, issue.path, module),
			code: issue.code,
			issue,
		}));
	const output = gate.output.slice(0, 16_000);
	try {
		const result = JSON.parse(
			output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1),
		);
		const reports = result?.error?.details?.reports;
		if (Array.isArray(reports)) {
			return reports.flatMap((report) =>
				Array.isArray(report.issues)
					? report.issues
							.filter(
								(issue: { severity?: string }) => issue.severity === 'error',
							)
							.map((issue: { path?: unknown; code?: unknown }) => ({
								...placeIssue(report.file, issue.path, module),
								...(typeof issue.code === 'string' ? { code: issue.code } : {}),
							}))
					: [],
			);
		}
	} catch {
		/* Compiler and formatter output is plain text. */
	}
	return output.split('\n').flatMap((line) => {
		const match =
			/^\s*(?:FAIL\s+)?((?:modules\/[a-z0-9-]+\/)?(?:src|tests|translations|migrations)\/[^\s:(]+)(?:\(\d+,\d+\)|:\d+|\s|$)/.exec(
				line,
			);
		if (!match) return [];
		const qualified = /^modules\/([a-z0-9-]+)\/(.+)$/.exec(match[1]!);
		return [
			{ path: qualified?.[2] ?? match[1]!, module: qualified?.[1] ?? module },
		];
	});
}

/* Every failure of one gate, each with the role that may write its fix. A
   location outside the session's draft modules, or one that climbs out of
   its module, is kept as a failure that names no file. */
function gateFailures(
	gate: GateResult,
	activeModule: string,
	roles: readonly AgentRoleDefinition[],
	modules: readonly string[],
): GateFailure[] {
	const module = gate.module ?? activeModule;
	const failures: GateFailure[] = locations(gate, module).map((location) => {
		const actionable =
			location.path !== null &&
			modules.includes(location.module) &&
			!location.path.split('/').includes('..');
		const path = actionable
			? ((location.code ? FIX_PATHS[location.code] : undefined) ??
				location.path)
			: null;
		return {
			gate,
			...(location.issue ? { issue: location.issue } : {}),
			module: actionable ? location.module : module,
			path,
			owner: path === null ? null : ownerOf(path, roles),
		};
	});
	return failures.length > 0
		? failures
		: [{ gate, module, path: null, owner: null }];
}

/* Who repairs the gates that did not pass, and with what. The role that may
   write the file of the first failure takes every failure in its files of
   that module; the rest wait for the turns after it. When no failure names a
   file a role owns, the fallback role takes the ones that name none.
   `exclude` is a role that just took a repair turn and changed nothing: it is
   not sent the same failures again, and null means nobody else can be. */
export function planGateRepair(input: {
	readonly gates: readonly GateResult[];
	readonly activeModule: string;
	readonly roles: readonly AgentRoleDefinition[];
	readonly modules: readonly string[];
	readonly fallback: string;
	readonly exclude: string | null;
}): GateRepair | null {
	const failures = input.gates.flatMap((gate) =>
		gateFailures(gate, input.activeModule, input.roles, input.modules),
	);
	const lead = failures.find(
		(failure) => failure.owner !== null && failure.owner !== input.exclude,
	);
	const unowned = failures.find((failure) => failure.owner === null);
	if (!lead && (!unowned || input.fallback === input.exclude)) return null;
	const role = lead?.owner ?? input.fallback;
	const module = (lead ?? unowned)!.module;
	const assigned = (failure: GateFailure) =>
		failure.module === module && failure.owner === (lead ? role : null);
	return {
		role,
		module,
		assigned: failures.filter(assigned),
		deferred: failures.filter((failure) => !assigned(failure)),
	};
}
