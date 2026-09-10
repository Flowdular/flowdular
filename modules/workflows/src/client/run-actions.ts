import type { WorkflowRunMode, WorkflowRunStatus } from '../domain/types.ts';

export function runActions(
	run: { readonly mode: WorkflowRunMode; readonly status: WorkflowRunStatus },
	permissions: { readonly execute: boolean; readonly cancel: boolean },
) {
	return {
		retry:
			run.mode === 'live' &&
			permissions.execute &&
			['failed', 'refused', 'cancelled'].includes(run.status),
		cancel:
			run.mode === 'live' &&
			permissions.cancel &&
			['queued', 'running', 'waiting-agent', 'waiting-retry'].includes(
				run.status,
			),
	};
}
