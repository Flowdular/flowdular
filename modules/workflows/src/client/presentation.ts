import { activeLocale, t } from '@coreloom/client/i18n';
import type {
	WorkflowCostRollupV1,
	WorkflowRunStatus,
	WorkflowUsageRollupV1,
} from '../domain/types.ts';
import type { TagTone } from '@coreloom/ui';

export const RUN_STATUSES: readonly WorkflowRunStatus[] = [
	'queued',
	'running',
	'waiting-agent',
	'waiting-retry',
	'cancel-requested',
	'succeeded',
	'failed',
	'refused',
	'cancelled',
];

export function workflowStatusTone(status: WorkflowRunStatus): TagTone {
	if (status === 'succeeded') return 'success';
	if (status === 'failed' || status === 'refused') return 'danger';
	if (status === 'waiting-retry' || status === 'cancel-requested')
		return 'warning';
	if (status === 'running' || status === 'waiting-agent') return 'info';
	return 'neutral';
}

export function dateTime(value: number | null): string {
	if (value === null) return t('workflows.common.notAvailable');
	return new Intl.DateTimeFormat(activeLocale(), {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(value);
}

export function duration(value: number | null): string {
	if (value === null) return t('workflows.common.notAvailable');
	if (value < 1_000) return t('workflows.duration.milliseconds', { value });
	return t('workflows.duration.seconds', {
		value: new Intl.NumberFormat(activeLocale(), {
			minimumFractionDigits: 1,
			maximumFractionDigits: 1,
		}).format(value / 1_000),
	});
}

export function usageLabel(usage: WorkflowUsageRollupV1): string {
	if (usage.state === 'not-applicable')
		return t('workflows.usage.notApplicable');
	return t('workflows.usage.tokens', { value: usage.totalTokens });
}

export function costLabel(cost: WorkflowCostRollupV1): string {
	if (cost.state === 'not-applicable') return t('workflows.cost.notApplicable');
	return new Intl.NumberFormat(activeLocale(), {
		style: 'currency',
		currency: cost.currency,
		minimumFractionDigits: 4,
	}).format(cost.amountMicros / 1_000_000);
}
