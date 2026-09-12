import type {
	ReportProvider,
	ReportProviderAnswer,
} from '@flowdular/module-reports';
import { AGENT_PERMISSIONS } from '../acl/permissions.ts';
import type { AgentUsageDay } from '../domain/types.ts';
import type { AgentRepository } from './repository.ts';

export const AGENT_RUNS_REPORT_PROVIDER_KEY = 'agents.runs';

export const AGENT_RUNS_REPORT_PROVIDER_LABEL = 'Agent runs';

/**
 * This module's own bundle names the provider, its tiles and its lines; the
 * English literals beside each key are what a deployment without the bundle,
 * or a locale that lacks the key, still shows.
 */
export const AGENT_RUNS_REPORT_LABEL_KEYS = {
	provider: 'agents.report.runs.label',
	runs: 'agents.report.runs.tile.runs',
	tokens: 'agents.report.runs.tile.tokens',
	runsPerDay: 'agents.report.runs.series.runsPerDay',
	tokensPerDay: 'agents.report.runs.series.tokensPerDay',
} as const;

/**
 * Runs and tokens as the run cost rollup already holds them: totals as tiles,
 * one point per day as series. The rollup groups by day inside the range, and
 * reports.core bounds a range to the same number of days a series may carry,
 * so the point count can never pass the contract's bound.
 */
export function runsAnswer(
	days: readonly AgentUsageDay[],
): ReportProviderAnswer {
	let runs = 0;
	let tokens = 0;
	const runPoints: { at: string; value: number }[] = [];
	const tokenPoints: { at: string; value: number }[] = [];
	for (const day of days) {
		const dayTokens = day.inputTokens + day.outputTokens;
		runs += day.runs;
		tokens += dayTokens;
		runPoints.push({ at: day.day, value: day.runs });
		tokenPoints.push({ at: day.day, value: dayTokens });
	}
	return {
		tiles: [
			{
				key: 'runs',
				label: 'Runs',
				tileLabelKey: AGENT_RUNS_REPORT_LABEL_KEYS.runs,
				value: runs,
				unit: 'runs',
			},
			{
				key: 'tokens',
				label: 'Tokens',
				tileLabelKey: AGENT_RUNS_REPORT_LABEL_KEYS.tokens,
				value: tokens,
				unit: 'tokens',
			},
		],
		series: [
			{
				key: 'runs',
				label: 'Runs per day',
				seriesLabelKey: AGENT_RUNS_REPORT_LABEL_KEYS.runsPerDay,
				points: runPoints,
			},
			{
				key: 'tokens',
				label: 'Tokens per day',
				seriesLabelKey: AGENT_RUNS_REPORT_LABEL_KEYS.tokensPerDay,
				points: tokenPoints,
			},
		],
	};
}

function aborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

/**
 * This workspace's agent runs as a report provider. The read is the existing
 * rollup under this module's own tenant transaction, with the tenant
 * reports.core resolved from the principal; it prices nothing and writes
 * nothing.
 */
export function createAgentRunsReportProvider(
	repository: () => Promise<AgentRepository>,
): ReportProvider {
	return {
		key: AGENT_RUNS_REPORT_PROVIDER_KEY,
		label: AGENT_RUNS_REPORT_PROVIDER_LABEL,
		labelKey: AGENT_RUNS_REPORT_LABEL_KEYS.provider,
		permission: AGENT_PERMISSIONS.runsRead,
		async read({ tenantId, range, signal }): Promise<ReportProviderAnswer> {
			if (aborted(signal)) return { tiles: [] };
			const days = await (
				await repository()
			).usageByDay(tenantId, range.from, range.to, { signal });
			if (aborted(signal)) return { tiles: [] };
			return runsAnswer(days);
		},
	};
}
