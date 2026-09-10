import { t } from '@flowdular/client/i18n';
import type { HandoffPlan } from '../server/sessions.ts';
import type { EjectStep } from './api.ts';

const ROLES = new Set([
	'planner',
	'business-manager',
	'backend-engineer',
	'frontend-engineer',
	'ux-designer',
	'agentic-engineer',
]);
const GATES = new Set([
	'auto-review',
	'spec-schema',
	'module-schema',
	'dependencies',
	'typecheck',
	'tests',
	'format',
]);
export const DELIVERY_STEPS = [
	'provider',
	'review',
	'pack',
	'fork',
	'fetch',
	'worktree',
	'branch',
	'copy',
	'remove',
	'install',
	'enable',
	'scopes',
	'verify',
	'guardrails',
	'commit',
	'push',
	'pr',
	'cleanup',
	'build',
	'restart',
] as const;

export function roleLabel(id: string, fallback = id): string {
	return ROLES.has(id) ? t('sandbox.dashboard.role.' + id) : fallback;
}

export function gateLabel(id: string): string {
	return GATES.has(id) ? t('sandbox.gates.name.' + id) : id;
}

export function handoffLabel(handoff: HandoffPlan): string {
	return t('sandbox.handoff.' + handoff.kind);
}

export function deliveryStepLabel(step: EjectStep): string {
	if (step.gateId)
		return (
			gateLabel(step.gateId) + (step.module ? ' (' + step.module + ')' : '')
		);
	return DELIVERY_STEPS.some((id) => id === step.id)
		? t('sandbox.delivery.step.' + step.id)
		: step.label;
}

export function deliveryStepDetail(step: EjectStep): string {
	if (step.gateId && step.status !== 'failed' && step.status !== 'running') {
		return t(
			'sandbox.gates.status.' +
				(step.status === 'note' ? 'skipped' : step.status),
		);
	}
	return step.files !== undefined
		? t('sandbox.eject.detail.files', { count: step.files })
		: step.detail;
}
