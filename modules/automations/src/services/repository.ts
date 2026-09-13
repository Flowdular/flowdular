import type {
	AutomationAuditEvent,
	AutomationAuditVerification,
	AutomationSchedule,
	AutomationTrigger,
} from '../domain/types.ts';
import type { UserActor } from '@flowdular/kernel';
import type { EncryptedSecret } from './secret-vault.ts';

export interface StoredAutomationSchedule
	extends Omit<
		AutomationSchedule,
		'agentName' | 'targetName' | 'targetAvailable'
	> {
	readonly configuredBy: UserActor;
	readonly permissionSnapshot: readonly string[];
}
export interface StoredAutomationTrigger
	extends Omit<
		AutomationTrigger,
		'agentName' | 'targetName' | 'targetAvailable'
	> {
	readonly configuredBy: UserActor;
	readonly permissionSnapshot: readonly string[];
}

export interface AutomationTriggerRecord extends StoredAutomationTrigger {
	readonly secret: EncryptedSecret;
}

export interface StoredAutomationTriggerWithSecret
	extends StoredAutomationTrigger {
	readonly secret: EncryptedSecret;
}

/** The database-agnostic business port. No driver type crosses it. */
/**
 * What a cross-tenant scheduler poll is allowed to learn: which tenant owns a
 * due schedule, which schedule it is, and when it was due. Labels, templates,
 * secrets and the configuring actor stay invisible until the schedule is read
 * again under its own tenant.
 */
export interface AutomationScheduleRouting {
	readonly tenantId: string;
	readonly id: string;
	readonly nextRunAt: number;
}

export type AutomationListSortKey = 'label' | 'updatedAt';

export const AUTOMATION_LIST_SORT_KEYS: readonly AutomationListSortKey[] = [
	'label',
	'updatedAt',
];

/** The keyset of the last row of a page: the sort value, then the id. */
export interface AutomationListCursor {
	readonly value: string | number;
	readonly id: string;
}

export interface AutomationListQuery {
	readonly sort: AutomationListSortKey;
	readonly direction: 'asc' | 'desc';
	readonly enabled?: boolean | undefined;
	/** Substring of the label or the target key. */
	readonly search?: string | undefined;
	readonly limit: number;
	readonly after?: AutomationListCursor | null | undefined;
}

export interface AutomationListPage<Item> {
	readonly items: readonly Item[];
	/** The keyset to continue from; null once the page was short. */
	readonly next: AutomationListCursor | null;
}

export interface AutomationsRepository {
	/** Every schedule of one workspace; only `retime` walks a whole workspace. */
	listSchedules(tenantId: string): Promise<readonly StoredAutomationSchedule[]>;
	listSchedulesPage(
		tenantId: string,
		query: AutomationListQuery,
	): Promise<AutomationListPage<StoredAutomationSchedule>>;
	getSchedule(
		tenantId: string,
		scheduleId: string,
	): Promise<StoredAutomationSchedule | null>;
	createSchedule(
		schedule: StoredAutomationSchedule,
	): Promise<StoredAutomationSchedule>;
	updateSchedule(
		schedule: StoredAutomationSchedule,
	): Promise<StoredAutomationSchedule>;
	deleteSchedule(tenantId: string, scheduleId: string): Promise<boolean>;
	listDueSchedules(
		now: number,
		limit: number,
	): Promise<readonly AutomationScheduleRouting[]>;
	advanceSchedule(input: {
		readonly tenantId: string;
		readonly scheduleId: string;
		readonly firedSlot: number;
		readonly nextRunAt: number;
		readonly lastRunAt: number;
		readonly lastRunId: string | null;
		readonly lastError: string | null;
	}): Promise<boolean>;
	/** Moves a pending slot only while it still holds the value that was read. */
	retimeSchedule(input: {
		readonly tenantId: string;
		readonly scheduleId: string;
		readonly expectedNextRunAt: number;
		readonly nextRunAt: number;
		readonly updatedAt: number;
	}): Promise<boolean>;
	disableSchedule(
		tenantId: string,
		scheduleId: string,
		reason: string,
		now: number,
	): Promise<boolean>;
	listTriggersPage(
		tenantId: string,
		query: AutomationListQuery,
	): Promise<AutomationListPage<StoredAutomationTrigger>>;
	getTrigger(
		tenantId: string,
		triggerId: string,
	): Promise<StoredAutomationTrigger | null>;
	findTriggerForFire(
		triggerId: string,
	): Promise<StoredAutomationTriggerWithSecret | null>;
	createTrigger(
		record: AutomationTriggerRecord,
	): Promise<StoredAutomationTrigger>;
	updateTrigger(
		record: StoredAutomationTrigger,
	): Promise<StoredAutomationTrigger | null>;
	rotateTriggerSecret(
		tenantId: string,
		triggerId: string,
		secret: EncryptedSecret,
		now: number,
	): Promise<StoredAutomationTrigger | null>;
	deleteTrigger(tenantId: string, triggerId: string): Promise<boolean>;
	recordTriggerOutcome(
		tenantId: string,
		triggerId: string,
		accepted: boolean,
		occurredAt: number,
	): Promise<void>;
	appendAuditEvent(
		event: Omit<
			AutomationAuditEvent,
			'id' | 'sequence' | 'previousHash' | 'eventHash'
		>,
	): Promise<AutomationAuditEvent>;
	listAuditEvents(
		tenantId: string,
		limit: number,
	): Promise<readonly AutomationAuditEvent[]>;
	verifyAuditChain(tenantId: string): Promise<AutomationAuditVerification>;
	/** One keyset page of the trail, ordered by id, for the data class export. */
	exportAuditEventsPage(
		tenantId: string,
		afterId: string,
		limit: number,
	): Promise<readonly AutomationAuditEvent[]>;
}
