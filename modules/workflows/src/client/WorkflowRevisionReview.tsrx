import { t } from '@coreloom/client';
import { Tag } from '@coreloom/ui';
import type {
	WorkflowDefinitionDetail,
	WorkflowGraphV1,
} from '../domain/types.ts';
import { workflowChangeSummary } from './canvas-model.ts';

export function WorkflowRevisionReview(props: {
	readonly detail: WorkflowDefinitionDetail;
	readonly graph: WorkflowGraphV1;
}) @{
	const publishedRevision = props.detail.definition.publishedRevision;
	const published =
		publishedRevision === null
			? null
			: props.detail.revisions.find(
				(revision) => revision.revision === publishedRevision,
			) ?? null;
	const summary = workflowChangeSummary(published?.graph ?? null, props.graph);

	<section
		class="workflow-revision-review"
		aria-label={t('workflows.revision.label')}
	>
		<span class="ui-cell">
			<b>{t('workflows.revision.title')}</b>
			<small>
				{published
					? t('workflows.revision.comparedWith', {
							revision: published.revision,
						})
					: t('workflows.revision.unpublished')}
			</small>
		</span>
		<span class="workflow-revision-review__changes">
			<Tag tone={summary.semanticChanged ? 'info' : 'neutral'}>{t(
				summary.semanticChanged
					? 'workflows.revision.semanticChanged'
					: 'workflows.revision.semanticUnchanged',
			)}</Tag>
			<Tag tone={summary.layoutChanged ? 'info' : 'neutral'}>{t(
				summary.layoutChanged
					? 'workflows.revision.layoutChanged'
					: 'workflows.revision.layoutUnchanged',
			)}</Tag>
		</span>
	</section>
}
