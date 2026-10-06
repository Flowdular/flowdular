import { Alert } from '@flowdular/ui';
import type { HandoffPlan } from '../server/sessions.ts';
import type { ModuleSpecReview } from '../server/spec.ts';
import { SpecReviewCard } from './SpecReviewCard.tsrx';
import { useTranslation } from './i18n.ts';

export function ApprovalHandoff(props: {
	readonly handoff: HandoffPlan;
	readonly reviews: readonly ModuleSpecReview[];
	readonly busy: boolean;
	/* The hash names the exact text the operator reviewed on this card. */
	readonly onApprove: (handoff: HandoffPlan, specHash: string) => void;
	readonly onRequestChanges: (module: string, comment: string) => void;
	readonly onEdit: (module: string) => void;
}) @{
	const { t } = useTranslation();
	const review =
		props.handoff.module
			? props.reviews.find((entry) => entry.module === props.handoff.module)
			: props.reviews.length === 1
				? props.reviews[0]
				: undefined;
	@if (review) {
		<SpecReviewCard
			review={review}
			busy={props.busy}
			onApprove={() => props.onApprove(
				{ ...props.handoff, module: review.module },
				review.hash ?? '',
			)}
			onRequestChanges={(comment) => props.onRequestChanges(
				review.module,
				comment,
			)}
			onEdit={() => props.onEdit(review.module)}
		/>
	} @else {
		<Alert>{t('sandbox.spec.reviewUnavailable')}</Alert>
	}
}
