import type {
	AutomationAuditEvent,
	AutomationAuditVerification,
	AutomationSchedule,
	AutomationTrigger,
} from '../domain/types.ts';
import type { UserActor } from '@coreloom/kernel';
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

export interface AutomationsRepository {
	listSchedules(tenantId: string): readonly StoredAutomationSchedule[];
	getSchedule(
		tenantId: string,
		scheduleId: string,
	): StoredAutomationSchedule | null;
	createSchedule(schedule: StoredAutomationSchedule): StoredAutomationSchedule;
	updateSchedule(schedule: StoredAutomationSchedule): StoredAutomationSchedule;
	deleteSchedule(tenantId: string, scheduleId: string): boolean;
	listDueSchedules(
		now: number,
		limit: number,
	): readonly StoredAutomationSchedule[];
	advanceSchedule(input: {
		readonly tenantId: string;
		readonly scheduleId: string;
		readonly firedSlot: number;
		readonly nextRunAt: number;
		readonly lastRunAt: number;
		readonly lastRunId: string | null;
		readonly lastError: string | null;
	}): boolean;
	disableSchedule(
		tenantId: string,
		scheduleId: string,
		reason: string,
		now: number,
	): boolean;
	listTriggers(tenantId: string): readonly StoredAutomationTrigger[];
	getTrigger(
		tenantId: string,
		triggerId: string,
	): StoredAutomationTrigger | null;
	findTriggerForFire(
		triggerId: string,
	): StoredAutomationTriggerWithSecret | null;
	createTrigger(record: AutomationTriggerRecord): StoredAutomationTrigger;
	updateTrigger(
		record: StoredAutomationTrigger,
	): StoredAutomationTrigger | null;
	rotateTriggerSecret(
		tenantId: string,
		triggerId: string,
		secret: EncryptedSecret,
		now: number,
	): StoredAutomationTrigger | null;
	deleteTrigger(tenantId: string, triggerId: string): boolean;
	recordTriggerOutcome(
		triggerId: string,
		accepted: boolean,
		occurredAt: number,
	): void;
	appendAuditEvent(
		event: Omit<
			AutomationAuditEvent,
			'id' | 'sequence' | 'previousHash' | 'eventHash'
		>,
	): AutomationAuditEvent;
	listAuditEvents(
		tenantId: string,
		limit: number,
	): readonly AutomationAuditEvent[];
	verifyAuditChain(tenantId: string): AutomationAuditVerification;
}
