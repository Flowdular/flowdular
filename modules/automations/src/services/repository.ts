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

export interface AutomationsRepository {
	listSchedules(tenantId: string): Promise<readonly StoredAutomationSchedule[]>;
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
	disableSchedule(
		tenantId: string,
		scheduleId: string,
		reason: string,
		now: number,
	): Promise<boolean>;
	listTriggers(tenantId: string): Promise<readonly StoredAutomationTrigger[]>;
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
}
