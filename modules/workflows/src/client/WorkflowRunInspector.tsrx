import { t } from '@coreloom/client';
import { Button, Tag } from '@coreloom/ui';
import type { WorkflowRunDetail } from '../domain/types.ts';
import { evidenceText } from './canvas-model.ts';
import {
	costLabel,
	duration,
	usageLabel,
	workflowStatusTone,
} from './presentation.ts';

const RETRYABLE = ['failed', 'refused', 'cancelled'] as const;

export function WorkflowRunInspector(props: {
	readonly detail: WorkflowRunDetail;
	readonly selectedNodeId: string;
	readonly canCancel: boolean;
	readonly busy: boolean;
	readonly onClose: () => void;
	readonly onCancel: () => void;
	readonly onRetry: () => void;
}) @{
	const retryable = RETRYABLE.includes(
		props.detail.run.status as (typeof RETRYABLE)[number],
	);
	const selectedExecution = props.detail.nodes.find(
		(node) => node.nodeId === props.selectedNodeId,
	);
	const selectedAttempt = selectedExecution?.attempts.at(-1) ?? null;
	const events = props.detail.events.map(
		(event) => ({ key: event.eventId, event }),
	);

	<section
		class="workflow-run-inspector"
		aria-label={t('workflows.runDetail.label')}
	>
		<div class="workflow-panel-head workflow-panel-head--row">
			<span class="ui-cell">
				<b>{props.detail.run.workflowName}</b>
				<small class="ui-mono">{props.detail.run.id}</small>
			</span>
			<span class="workflow-run-head-actions">
				<Tag tone={workflowStatusTone(props.detail.run.status)} dot>{t(
					'workflows.runStatus.' + props.detail.run.status,
				)}</Tag>
				<Button size="sm" onClick={props.onClose}>{t(
					'workflows.runDetail.close',
				)}</Button>
			</span>
		</div>
		<div class="workflow-run-metrics">
			<span>
				<small>{t('workflows.runDetail.mode')}</small>
				<b>{t('workflows.mode.' + props.detail.run.mode)}</b>
			</span>
			<span>
				<small>{t('workflows.runDetail.duration')}</small>
				<b>{duration(props.detail.run.durationMs)}</b>
			</span>
			<span>
				<small>{t('workflows.runDetail.usage')}</small>
				<b>{usageLabel(props.detail.run.usage)}</b>
			</span>
			<span>
				<small>{t('workflows.runDetail.cost')}</small>
				<b>{costLabel(props.detail.run.cost)}</b>
			</span>
		</div>
		<div class="workflow-evidence-grid">
			<div>
				<b>{t('workflows.runDetail.input')}</b>
				<pre class="ui-code">{evidenceText(props.detail.input)}</pre>
			</div>
			<div>
				<b>{t('workflows.runDetail.output')}</b>
				<pre class="ui-code">{evidenceText(props.detail.output)}</pre>
			</div>
		</div>
		@if (selectedExecution) {
			<div class="workflow-node-evidence">
				<div class="workflow-panel-head workflow-panel-head--row">
					<span class="ui-cell">
						<b>{t('workflows.runDetail.nodeEvidence')}</b>
						<small class="ui-mono">{selectedExecution.nodeId}</small>
					</span>
					<Tag tone="neutral">{t(
						'workflows.nodeStatus.' + selectedExecution.status,
					)}</Tag>
				</div>
				@if (selectedAttempt) {
					<div class="workflow-evidence-grid">
						<div>
							<b>{t('workflows.runDetail.nodeInput')}</b>
							<pre class="ui-code">{evidenceText(selectedAttempt.input)}</pre>
						</div>
						<div>
							<b>{t('workflows.runDetail.nodeOutput')}</b>
							<pre class="ui-code">{evidenceText(selectedAttempt.output)}</pre>
						</div>
					</div>
				} @else {
					<p class="workflow-node-evidence__empty">{t(
						'workflows.runDetail.nodeNotStarted',
					)}</p>
				}
			</div>
		}
		<details class="workflow-events">
			<summary>{t('workflows.runDetail.events', {
				count: events.length,
			})}</summary>
			<ol>
				@for (const entry of events; key entry.key) {
					<li>
						<span class="num">{entry.event.sequence}</span>
						<code class="ui-mono">{entry.event.type}</code>
						@if (entry.event.virtualOffsetMs !== undefined) {
							<small>{t('workflows.runDetail.virtualOffset', {
								value: entry.event.virtualOffsetMs,
							})}</small>
						}
					</li>
				}
			</ol>
		</details>
		<div class="ui-form__actions workflow-run-actions">
			@if (retryable) {
				<Button disabled={props.busy} onClick={props.onRetry}>{t(
					'workflows.runDetail.retry',
				)}</Button>
			} @else if (props.canCancel) {
				<Button
					variant="danger"
					disabled={props.busy}
					onClick={props.onCancel}
				>{t('workflows.runDetail.cancel')}</Button>
			}
		</div>
	</section>
}
