/* The metering.core meter contract, declared here rather than imported.
   agents.core depends on metering.core and requires metering.meters.v1, so the
   module registry composes metering.core first and refuses a deployment
   without it. The mirror is what keeps the dependency a capability rather than
   a package import: this module reads the registry through the platform and
   never reaches metering.core's own code or tables. It is the contract
   metering.core owns (modules/metering/src/domain/meters.ts) and must not
   drift from it. */
export const METERING_METERS_CAPABILITY = 'metering.meters.v1';

/** The stable code this module records when `check` refuses a run. */
export const METER_LIMIT_EXCEEDED = 'METER_LIMIT_EXCEEDED';

export type MeterKind = 'cumulative' | 'gauge';

export interface MeterDeclaration {
	readonly key: string;
	readonly label: string;
	readonly unit: string;
	readonly kind: MeterKind;
}

export interface MeterRecordInput {
	readonly tenantId: string;
	/** The full key, `<moduleId>.<key>`, as `declare` composed it. */
	readonly meter: string;
	readonly amount: number;
	readonly at?: number;
	/** Makes the fact idempotent. Without it every call counts again. */
	readonly sourceRef?: string;
}

export interface MeterRecordResult {
	readonly recorded: boolean;
	readonly day: string;
}

export interface MeterCheckInput {
	readonly tenantId: string;
	readonly meter: string;
	readonly amount: number;
}

export type MeterVerdict = 'allowed' | 'warning' | 'refused';

export interface MeterCheckResult {
	readonly verdict: MeterVerdict;
	readonly used: number;
	readonly limit: number | null;
}

export interface MeterRegistry {
	declare(moduleId: string, meters: readonly MeterDeclaration[]): void;
	record(input: MeterRecordInput): Promise<MeterRecordResult>;
	check(input: MeterCheckInput): Promise<MeterCheckResult>;
}

/* Read at the point of use, never captured at composition time, so a run reads
   the registry the platform holds now rather than one this module closed over
   while it composed. Null is a process that built this module outside the
   module registry, such as a test that constructs a worker of its own; a
   composed deployment always has the provider. */
export type MeterRegistryResolver = () => MeterRegistry | null;

/**
 * The month a refusal belongs to, as `YYYY-MM` in UTC. A limit is monthly, so
 * a standing refusal is keyed by the month it was recorded in and answers again
 * as soon as the month turns.
 */
export function meterPeriod(at: number): string {
	return new Date(at).toISOString().slice(0, 7);
}

/** The meter keys as metering.core composes them, for `record` and `check`. */
export const AGENT_METERS = {
	runTokens: 'agents.core.run-tokens',
	runs: 'agents.core.runs',
} as const;

/**
 * What agents.core counts. Declared at composition, once, so the workspace
 * sees both meters whether or not a run has happened yet.
 */
export const AGENT_METER_DECLARATIONS: readonly MeterDeclaration[] = [
	{
		key: 'run-tokens',
		label: 'Agent run tokens',
		unit: 'tokens',
		kind: 'cumulative',
	},
	{ key: 'runs', label: 'Agent runs', unit: 'runs', kind: 'cumulative' },
];

/**
 * What one run may cost before it starts. The prompt and the resolved
 * instructions are the tokens the provider is certain to read, at the four
 * characters per token the bundled catalogue prices with, and the output limit
 * is the most it may write back. It is an estimate, so a run may still settle
 * above or below it; the limit it is checked against is a monthly ceiling, not
 * a per-run budget, and the settled fact replaces this guess.
 */
export function estimateRunTokens(input: {
	readonly instructions: string;
	readonly input: string;
	readonly maxOutputTokens: number;
}): number {
	return (
		Math.ceil((input.instructions.length + input.input.length) / 4) +
		Math.max(0, Math.trunc(input.maxOutputTokens))
	);
}
