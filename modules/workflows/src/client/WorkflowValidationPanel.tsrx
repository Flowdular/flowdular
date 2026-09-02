import { t } from '@coreloom/client';
import { Alert, EmptyState, Tag } from '@coreloom/ui';
import type {
	WorkflowDryRunResponseV1,
	WorkflowGraphV1,
} from '../domain/types.ts';

export function WorkflowValidationPanel(props: {
	readonly report: WorkflowDryRunResponseV1 | null;
	readonly graph: WorkflowGraphV1;
	readonly busy: boolean;
}) @{
	const issues = (props.report?.issues ?? []).map(
		(issue, index) => ({
			key: `${issue.code}.${index}`,
			issue,
			location: issue.location.kind === 'node'
				? issue.location.nodeId
				: issue.location.kind === 'edge'
					? issue.location.edgeId
					: t('workflows.validation.graph'),
		}),
	);
	const references = (props.report?.references ?? []).map(
		(reference) => ({
			key: `${reference.kind}.${reference.id}.${reference.version}`,
			reference,
		}),
	);
	const mappings = props.graph.nodes.flatMap(
		(node) => (node.mappings ?? []).map(
			(mapping, index) => ({
				key: `${node.id}.${mapping.targetPointer}.${index}`,
				nodeId: node.id,
				target: mapping.targetPointer,
				binding: mapping.binding.kind,
			}),
		),
	);

	<section class="workflow-panel" aria-label={t('workflows.validation.label')}>
		<div class="workflow-panel-head workflow-panel-head--row">
			<span class="ui-cell">
				<b>{t('workflows.validation.title')}</b>
				<small>{t('workflows.validation.description')}</small>
			</span>
			@if (props.report) {
				<Tag tone={props.report.valid ? 'success' : 'danger'} dot>{t(
					props.report.valid
						? 'workflows.validation.valid'
						: 'workflows.validation.invalid',
				)}</Tag>
			}
		</div>
		<div class="workflow-panel__body">
			@if (props.busy) {
				<p>{t('workflows.validation.running')}</p>
			} @else if (!props.report) {
				<EmptyState
					icon="check"
					title={t('workflows.validation.emptyTitle')}
				>{t('workflows.validation.emptyHint')}</EmptyState>
			} @else {
				<>
					<div class="workflow-validation-summary">
						<span>
							<b>{t('workflows.validation.order')}</b>
						</span>
						<code class="ui-code">
							{props.report.compiledOrder.join(' → ') ||
								t('workflows.common.none')}
						</code>
						<span>
							<b>{t('workflows.validation.permissions')}</b>
						</span>
						<code class="ui-code">
							{props.report.requiredPermissions.join(', ') ||
								t('workflows.common.none')}
						</code>
						<span>
							<b>{t('workflows.validation.references')}</b>
						</span>
						<div class="workflow-validation-list">
							@if (references.length === 0) {
								<small>{t('workflows.common.none')}</small>
							} @else {
								@for (const entry of references; key entry.key) {
									<span>
										<Tag
											tone={entry.reference.available ? 'neutral' : 'danger'}
										>{t('workflows.reference.' + entry.reference.kind)}</Tag>
										<code class="ui-mono">
											{entry.reference.id + '@' + entry.reference.version}
										</code>
									</span>
								}
							}
						</div>
						<span>
							<b>{t('workflows.validation.mappings')}</b>
						</span>
						<div class="workflow-validation-list">
							@if (mappings.length === 0) {
								<small>{t('workflows.common.none')}</small>
							} @else {
								@for (const entry of mappings; key entry.key) {
									<code class="ui-mono">
										{entry.nodeId + ' → ' + entry.target + ' (' +
											entry.binding +
											')'}
									</code>
								}
							}
						</div>
					</div>
					@if (issues.length === 0) {
						<Alert tone="info">{t('workflows.validation.noIssues')}</Alert>
					} @else {
						<ul class="workflow-issue-list">
							@for (const entry of issues; key entry.key) {
								<li>
									<Tag
										tone={entry.issue.severity === 'error'
											? 'danger'
											: 'warning'}
									>{entry.issue.code}</Tag>
									<span class="ui-cell">
										<b class="ui-mono">{entry.location}</b>
										<small>{entry.issue.message}</small>
									</span>
								</li>
							}
						</ul>
					}
				</>
			}
		</div>
	</section>
}
