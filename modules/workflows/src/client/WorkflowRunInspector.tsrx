import { t } from '@flowdular/client';
import { Button, CellTime, Tag } from '@flowdular/ui';
import type {
	WorkflowEdgeTransfer,
	WorkflowNodeAttempt,
	WorkflowPayloadEvidenceV1,
	WorkflowRunDetail,
} from '../domain/types.ts';
import { evidenceText } from './canvas-model.ts';
import {
	costLabel,
	duration,
	usageLabel,
	workflowStatusTone,
} from './presentation.ts';

import { runActions } from './run-actions.ts';
import { workflowNodeTrail } from './run-trail.ts';

function EvidenceBlock(props: {
	readonly label: string;
	readonly evidence: WorkflowPayloadEvidenceV1;
}) @{
	<div class="workflow-attempt-evidence">
		<b>{props.label}</b>
		<small>{t('workflows.runDetail.evidenceState', {
			state: t('workflows.runDetail.evidence.' + props.evidence.state),
		})}</small>
		<small class="ui-mono">
			{props.evidence.schemaId}
			·
			{props.evidence.hash}
		</small>
		<small>{t('workflows.runDetail.evidenceBytes', {
			count: props.evidence.originalByteSize,
		})}</small>
		<pre class="ui-code">{evidenceText(props.evidence)}</pre>
	</div>
}

function TraversedEdges(props: {
	readonly edges: readonly WorkflowEdgeTransfer[];
}) @{
	@if (props.edges.length > 0) {
		<div class="workflow-attempt-edges">
			<b>{t('workflows.runDetail.edges', { count: props.edges.length })}</b>
			<ul>
				@for (const edge of props.edges; key edge.edgeId) {
					<li>
						<span class="ui-mono">
							{edge.sourcePort}
							→
							{edge.targetNodeId}.{edge.targetPort}
						</span>
						<Tag tone={edge.state === 'emitted' ? 'success' : 'neutral'}>{t(
							'workflows.runDetail.edge.' + edge.state,
						)}</Tag>
						@if (edge.reason) {
							<small class="ui-mono">{edge.reason}</small>
						}
						<EvidenceBlock
							label={t('workflows.runDetail.edgeEvidence')}
							evidence={edge.evidence}
						/>
					</li>
				}
			</ul>
		</div>
	}
}

function AttemptEvidence(props: {
	readonly attempt: WorkflowNodeAttempt;
	readonly action: | {
			readonly actionId: string;
			readonly contractVersion: number;
	  }
	| null;
	readonly edges: readonly WorkflowEdgeTransfer[];
}) @{
	<article class="workflow-attempt">
		<div class="workflow-panel-head workflow-panel-head--row">
			<b>{t('workflows.runDetail.attempt', {
				number: props.attempt.attempt,
			})}</b>
			<Tag
				tone={props.attempt.status === 'succeeded'
					? 'success'
					: props.attempt.status === 'failed' ||
					props.attempt.status === 'refused'
						? 'danger'
						: 'neutral'}
			>{t('workflows.nodeStatus.' + props.attempt.status)}</Tag>
		</div>
		<dl class="workflow-attempt__facts">
			@if (props.action) {
				<>
					<dt>{t('workflows.runDetail.actionRef')}</dt>
					<dd
						class="ui-mono"
					>{`${props.action.actionId}@${props.action.contractVersion}`}</dd>
				</>
			}
			<dt>{t('workflows.runDetail.startedAt')}</dt>
			<dd>
				<CellTime value={props.attempt.startedAt} />
			</dd>
			@if (props.attempt.completedAt !== null) {
				<>
					<dt>{t('workflows.runDetail.completedAt')}</dt>
					<dd>
						<CellTime value={props.attempt.completedAt} />
					</dd>
				</>
			}
			<dt>{t('workflows.runDetail.duration')}</dt>
			<dd>{duration(props.attempt.durationMs)}</dd>
			@if (props.attempt.outcomePort) {
				<>
					<dt>{t('workflows.runDetail.outcome')}</dt>
					<dd class="ui-mono">{props.attempt.outcomePort}</dd>
				</>
			}
			@if (props.attempt.failureCode) {
				<>
					<dt>{t('workflows.runDetail.failureCode')}</dt>
					<dd class="ui-mono">{props.attempt.failureCode}</dd>
				</>
			}
			@if (props.attempt.childId) {
				<>
					<dt>{t('workflows.runDetail.child')}</dt>
					<dd class="ui-mono">
						{props.attempt.childKind}:
						{props.attempt.childId}
					</dd>
				</>
			}
			<dt>{t('workflows.runDetail.idempotency')}</dt>
			<dd class="ui-mono">{props.attempt.sideEffectIdempotencyKey}</dd>
		</dl>
		<div class="workflow-evidence-grid">
			<EvidenceBlock
				label={t('workflows.runDetail.nodeInput')}
				evidence={props.attempt.input}
			/>
			<EvidenceBlock
				label={t('workflows.runDetail.nodeOutput')}
				evidence={props.attempt.output}
			/>
		</div>
		<TraversedEdges edges={props.edges} />
	</article>
}

export function WorkflowRunInspector(props: {
	readonly detail: WorkflowRunDetail;
	readonly selectedNodeId: string;
	readonly canCancel: boolean;
	readonly canExecute: boolean;
	readonly busy: boolean;
	readonly onClose: () => void;
	readonly onCancel: () => void;
	readonly onRetry: () => void;
}) @{
	const actions = runActions(props.detail.run, {
		execute: props.canExecute,
		cancel: props.canCancel,
	});
	const trail = workflowNodeTrail(props.detail, props.selectedNodeId);
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
		@if (trail) {
			<div class="workflow-node-evidence">
				<div class="workflow-panel-head workflow-panel-head--row">
					<span class="ui-cell">
						<b>{t('workflows.runDetail.nodeEvidence')}</b>
						<small class="ui-mono">{trail.execution.nodeId}</small>
					</span>
					<Tag tone="neutral">{t(
						'workflows.nodeStatus.' + trail.execution.status,
					)}</Tag>
				</div>
				@if (trail.attempts.length > 0) {
					<div class="workflow-attempts">
						<b>{t('workflows.runDetail.attempts', {
							count: trail.attempts.length,
						})}</b>
						@for (const entry of trail.attempts; key entry.attempt.attempt) {
							<AttemptEvidence
								attempt={entry.attempt}
								action={trail.action}
								edges={entry.edges}
							/>
						}
					</div>
				} @else {
					<p class="workflow-node-evidence__empty">{t(
						'workflows.runDetail.nodeNotStarted',
					)}</p>
				}
				<TraversedEdges edges={trail.otherEdges} />
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
			@if (actions.retry) {
				<Button disabled={props.busy} onClick={props.onRetry}>{t(
					'workflows.runDetail.retry',
				)}</Button>
			} @else if (actions.cancel) {
				<Button
					variant="danger"
					disabled={props.busy}
					onClick={props.onCancel}
				>{t('workflows.runDetail.cancel')}</Button>
			}
		</div>
	</section>
}
