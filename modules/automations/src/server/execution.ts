import type { Actor } from '@flowdular/kernel';
import { AUTOMATIONS_PERMISSIONS } from '../acl/permissions.ts';
import { AutomationsServiceError } from '../services/automations-service.ts';
import type { AutomationScheduleService } from '../services/schedule-service.ts';

export const AUTOMATION_EXECUTION_CAPABILITY = 'automations.execution.v1';

export interface AutomationExecutionContext {
	readonly tenantId: string;
	readonly actor: Actor;
	readonly permissionSnapshot: readonly string[];
}

export interface AutomationScheduleRunRequest {
	readonly scheduleId: string;
	/* Attempt independent and owned by the caller. The agent run ledger binds it
	   to the request, so a repeat returns the first run. */
	readonly idempotencyKey: string;
	/* The target kinds this caller can dispatch. Every other kind is refused, so
	   a caller cannot re-enter its own module through a schedule that points
	   back at it. */
	readonly allowedTargetKinds: readonly string[];
}

export interface AutomationScheduleRunAccepted {
	readonly correlationId: string;
	readonly created: boolean;
	readonly targetKind: string;
}

export interface AutomationExecutionCapability {
	runScheduleNow(
		request: AutomationScheduleRunRequest,
		context: AutomationExecutionContext,
	): Promise<AutomationScheduleRunAccepted>;
}

export function createAutomationExecutionCapability(
	scheduleService: () => Promise<AutomationScheduleService>,
): AutomationExecutionCapability {
	return {
		async runScheduleNow(request, context) {
			const permissions = [...new Set(context.permissionSnapshot)].sort();
			if (!permissions.includes(AUTOMATIONS_PERMISSIONS.manage)) {
				throw new AutomationsServiceError(
					'AUTOMATION_PERMISSION_DENIED',
					`Running a schedule requires ${AUTOMATIONS_PERMISSIONS.manage}.`,
					403,
				);
			}
			if (request.allowedTargetKinds.length === 0) {
				throw new AutomationsServiceError(
					'AUTOMATION_TARGET_KIND_DENIED',
					'A caller must name at least one dispatchable target kind.',
					409,
				);
			}
			const outcome = await (
				await scheduleService()
			).runNow(
				context.tenantId,
				context.actor,
				request.scheduleId,
				permissions,
				{
					idempotencyKey: request.idempotencyKey,
					allowedTargetKinds: request.allowedTargetKinds,
				},
			);
			return {
				correlationId: outcome.id,
				created: outcome.created,
				targetKind: outcome.targetKind,
			};
		},
	};
}
