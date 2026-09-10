import type { AgentUsageSummary } from '../domain/types.ts';
import type { AgentSettingsReader } from '../settings.ts';
import type { AgentRepository } from './repository.ts';

/* The bucket a run is counted in. UTC so a tenant rollup does not move when a
   reader's clock does, and precomputed at write time so the aggregate stays an
   index scan instead of a per-row date conversion. */
export function usageDay(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;
const MAX_WINDOW_DAYS = 180;
const DEFAULT_WINDOW_DAYS = 30;

export interface BudgetRefusal {
	readonly code: string;
	readonly message: string;
}

function firstDayOfMonth(now: number): string {
	return `${usageDay(now).slice(0, 7)}-01`;
}

function usd(micros: number): string {
	return `$${(micros / 1_000_000).toFixed(2)}`;
}

/* Caps are entered in whole dollars and compared in micro-USD, the same unit
   every stored cost uses, so the comparison never crosses a float boundary. */
function capMicros(value: number): number {
	return Number.isFinite(value) && value > 0
		? Math.round(value * 1_000_000)
		: 0;
}

/* Reads the rollup the runs already wrote. It never prices a run itself: the
   price is applied once, when the run completes. */
export class AgentUsageService {
	constructor(
		private readonly repository: AgentRepository,
		private readonly settings?: AgentSettingsReader,
		private readonly now: () => number = Date.now,
	) {}

	async summary(
		tenantId: string,
		days = DEFAULT_WINDOW_DAYS,
	): Promise<AgentUsageSummary> {
		const window = Number.isSafeInteger(days)
			? Math.min(Math.max(1, days), MAX_WINDOW_DAYS)
			: DEFAULT_WINDOW_DAYS;
		const now = this.now();
		const to = usageDay(now);
		const from = usageDay(now - (window - 1) * DAY_MS);
		const monthFrom = firstDayOfMonth(now);
		return {
			from,
			to,
			days: await this.repository.usageByDay(tenantId, from, to),
			agents: await this.repository.usageByAgent(tenantId, from, to),
			month: {
				from: monthFrom,
				...(await this.repository.usageTotal(tenantId, monthFrom, null)),
			},
			caps: this.caps(tenantId),
		};
	}

	caps(tenantId: string): AgentUsageSummary['caps'] {
		return {
			monthlyCostMicroUsd: capMicros(
				this.settings?.monthlyCostCapUsd(tenantId) ?? 0,
			),
			agentMonthlyCostMicroUsd: capMicros(
				this.settings?.agentMonthlyCostCapUsd(tenantId) ?? 0,
			),
		};
	}

	/* Checked at enqueue against spend already settled. A run that is in flight
	   has not reported usage yet, so concurrent enqueues can overshoot a cap by
	   the cost of the runs still executing; a run over the cap is never killed
	   mid-way, only the next enqueue is refused. */
	async check(
		tenantId: string,
		agentId: string,
		now = this.now(),
	): Promise<BudgetRefusal | null> {
		const caps = this.caps(tenantId);
		if (caps.monthlyCostMicroUsd === 0 && caps.agentMonthlyCostMicroUsd === 0) {
			return null;
		}
		const monthFrom = firstDayOfMonth(now);
		if (caps.monthlyCostMicroUsd > 0) {
			const spent = (
				await this.repository.usageTotal(tenantId, monthFrom, null)
			).costMicroUsd;
			if (spent >= caps.monthlyCostMicroUsd) {
				return {
					code: 'BUDGET_EXCEEDED',
					message: `The workspace has used ${usd(spent)} of its ${usd(caps.monthlyCostMicroUsd)} monthly agent budget.`,
				};
			}
		}
		if (caps.agentMonthlyCostMicroUsd > 0) {
			const spent = (
				await this.repository.usageTotal(tenantId, monthFrom, agentId)
			).costMicroUsd;
			if (spent >= caps.agentMonthlyCostMicroUsd) {
				return {
					code: 'BUDGET_EXCEEDED',
					message: `This agent has used ${usd(spent)} of its ${usd(caps.agentMonthlyCostMicroUsd)} monthly budget.`,
				};
			}
		}
		return null;
	}
}
