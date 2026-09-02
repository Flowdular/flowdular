import { Alert, Button, FormField } from '@coreloom/ui';
import { t } from '@coreloom/client';
import type { ExpenseClaimDecision, ExpensesClaim } from '../domain/types.ts';

export interface ExpenseDecisionFormProps {
	readonly claim: ExpensesClaim;
	readonly decision: ExpenseClaimDecision;
	readonly busy: boolean;
	readonly error: string;
	readonly onCancel: () => void;
	readonly onSubmit: (event: SubmitEvent) => void;
}

export function ExpenseDecisionForm(props: ExpenseDecisionFormProps) @{
	const approving = props.decision === 'approved';
	<form class="ui-drawer__form" onSubmit={props.onSubmit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<div class="ui-form__section-head">
					<b>{props.claim.title}</b>
					<small>
						{approving
							? t('expenses.decision.approveHelp')
							: t('expenses.decision.rejectHelp')}
					</small>
				</div>
				<FormField label={t('expenses.decision.comment')} required>
					<textarea
						class="ui-textarea"
						name="comment"
						maxlength={2000}
						autoFocus
						required
					></textarea>
				</FormField>
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>{t('expenses.decision.footer')}</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>{t('expenses.action.cancel')}</Button>
				<Button
					variant={approving ? 'primary' : 'danger'}
					type="submit"
					disabled={props.busy}
				>
					{props.busy
						? approving
							? t('expenses.action.approving')
							: t('expenses.action.rejecting')
						: approving
							? t('expenses.action.approveClaim')
							: t('expenses.action.rejectClaim')}
				</Button>
			</div>
		</div>
	</form>
}
