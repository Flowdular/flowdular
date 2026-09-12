/** How a meter counts. Declared once by the owning module, never by a reader. */
export const METER_KINDS = ['cumulative', 'gauge'] as const;
export type MeterKind = (typeof METER_KINDS)[number];

/** Which share of a limit a notification was sent for. */
export const METER_THRESHOLDS = ['warning', 'exhausted'] as const;
export type MeterThreshold = (typeof METER_THRESHOLDS)[number];

/** A meter as one workspace recorded it. `key` is `<moduleId>.<meter key>`. */
export interface Meter {
	readonly id: string;
	readonly tenantId: string;
	readonly key: string;
	readonly moduleId: string;
	readonly label: string;
	readonly unit: string;
	readonly kind: MeterKind;
	readonly createdAt: number;
}

/** The usage of one meter on one UTC day. */
export interface UsageBucket {
	readonly id: string;
	readonly tenantId: string;
	readonly meter: string;
	readonly day: string;
	readonly amount: number;
	readonly events: number;
	readonly updatedAt: number;
}

/** The operator's ceiling for one meter in one workspace, per calendar month. */
export interface MeterLimit {
	readonly id: string;
	readonly tenantId: string;
	readonly meter: string;
	readonly monthlyLimit: number;
	readonly setBy: string;
	readonly updatedAt: number;
}

/** A limit change as the CLI recorded it. Written once, never rewritten. */
export interface MeterLimitEvent {
	readonly id: string;
	readonly tenantId: string;
	readonly meter: string;
	readonly monthlyLimit: number;
	readonly previousLimit: number | null;
	readonly setBy: string;
	readonly occurredAt: number;
}

/** Evidence that a threshold notification was published for a month. */
export interface MeterThresholdNotice {
	readonly id: string;
	readonly tenantId: string;
	readonly meter: string;
	readonly month: string;
	readonly threshold: MeterThreshold;
	readonly sentAt: number;
}

/** One row of the usage screen and of the dashboard widget. */
export interface MeterUsage {
	readonly meter: Meter;
	/** UTC `YYYY-MM` the usage below was summed over. */
	readonly month: string;
	readonly used: number;
	/** The operator's ceiling, or null when this workspace is unlimited. */
	readonly limit: number | null;
}
