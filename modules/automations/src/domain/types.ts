export interface AutomationSchedule {
	readonly id: string;
	readonly tenantId: string;
	readonly targetKind: string;
	readonly targetKey: string;
	readonly targetName: string;
	readonly targetAvailable: boolean;
	/* Compatibility fields for existing agent schedules. Workflow targets keep
	   them empty so no consumer can mistake a workflow key for an agent id. */
	readonly agentId: string;
	readonly agentName: string;
	readonly label: string;
	readonly inputTemplate: string;
	readonly cadence: string;
	readonly enabled: boolean;
	readonly disabledReason: string | null;
	readonly nextRunAt: number;
	readonly lastRunAt: number | null;
	readonly lastRunId: string | null;
	readonly lastError: string | null;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly createdBy: string;
}

export interface CreateAutomationScheduleInput {
	readonly targetKind?: string;
	readonly targetKey?: string;
	readonly agentId?: string;
	readonly label: string;
	readonly inputTemplate: string;
	readonly cadence: string;
	readonly enabled: boolean;
}

export interface UpdateAutomationScheduleInput
	extends CreateAutomationScheduleInput {
	readonly id: string;
}

export interface AutomationTrigger {
	readonly id: string;
	readonly tenantId: string;
	readonly targetKind: string;
	readonly targetKey: string;
	readonly targetName: string;
	readonly targetAvailable: boolean;
	readonly agentId: string;
	readonly agentName: string;
	readonly label: string;
	readonly enabled: boolean;
	readonly secretRevision: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly createdBy: string;
	readonly lastFiredAt: number | null;
	readonly acceptedCount: number;
	readonly rejectedCount: number;
}

export interface AutomationTriggerSecret {
	readonly trigger: AutomationTrigger;
	readonly secret: string;
}

export interface CreateAutomationTriggerInput {
	readonly targetKind?: string;
	readonly targetKey?: string;
	readonly agentId?: string;
	readonly label: string;
	readonly enabled: boolean;
}

export interface UpdateAutomationTriggerInput
	extends CreateAutomationTriggerInput {
	readonly id: string;
}

export interface AutomationAuditEvent {
	readonly id: string;
	readonly tenantId: string;
	readonly sequence: number;
	readonly actorId: string;
	readonly action: string;
	readonly subjectType: 'automation-schedule' | 'automation-trigger';
	readonly subjectId: string;
	readonly metadata: Readonly<Record<string, string | number | boolean>>;
	readonly occurredAt: number;
	readonly previousHash: string | null;
	readonly eventHash: string;
}

export interface AutomationAuditVerification {
	readonly verified: boolean;
	readonly brokenAt: string | null;
}

export interface AutomationAgent {
	readonly id: string;
	readonly name: string;
	readonly status: 'draft' | 'active' | 'paused' | 'archived';
}

export interface AutomationTargetOption {
	readonly kind: string;
	readonly key: string;
	readonly label: string;
	readonly available: boolean;
	readonly revision?: number;
}
