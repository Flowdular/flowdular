import { matchesGlob } from 'node:path';
import type { AgentRoleDefinition } from '@flowdular/coding-agent';
import type { GateResult } from './gates.ts';

interface DiagnosticPath {
	path: string;
	module: string;
}

/* Read diagnostic locations, never instructions embedded in output. Manifest
   reports name the module; their issues name the file that actually failed. */
function locations(gate: GateResult, activeModule: string): DiagnosticPath[] {
	const module = gate.module ?? activeModule;
	const output = gate.output.slice(0, 16_000);
	try {
		const result = JSON.parse(
			output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1),
		);
		const reports = result?.error?.details?.reports;
		if (Array.isArray(reports)) {
			return reports.flatMap((report) => {
				const target =
					typeof report.file === 'string'
						? (/(?:^|\/)modules\/([a-z0-9-]+)\/module\.json$/.exec(
								report.file,
							)?.[1] ?? module)
						: module;
				return Array.isArray(report.issues)
					? report.issues
							.filter(
								(issue: { severity?: string; path?: unknown }) =>
									issue.severity === 'error' && typeof issue.path === 'string',
							)
							.map((issue: { path: string }) => ({
								path: issue.path,
								module: target,
							}))
					: [];
			});
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

export function gateRepairOwner(
	gate: GateResult,
	activeModule: string,
	roles: readonly AgentRoleDefinition[],
	modules: readonly string[],
): { role: string; module: string } | null {
	for (const location of locations(gate, activeModule)) {
		if (
			!modules.includes(location.module) ||
			location.path.split('/').includes('..')
		)
			continue;
		const preferred =
			location.path.startsWith('src/client/') ||
			location.path.startsWith('translations/')
				? 'frontend-engineer'
				: location.path.startsWith('spec/')
					? 'business-manager'
					: location.path.startsWith('src/agent/') ||
						  location.path.startsWith('src/tools/')
						? 'agentic-engineer'
						: 'backend-engineer';
		const candidates = roles.filter((role) =>
			role.allowedPaths.some((pattern) => matchesGlob(location.path, pattern)),
		);
		const owner =
			candidates.find((role) => role.id === preferred) ??
			(candidates.length === 1 ? candidates[0] : undefined);
		if (owner) return { role: owner.id, module: location.module };
	}
	return null;
}
