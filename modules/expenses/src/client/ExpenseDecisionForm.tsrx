import { Alert, Button, FormField } from '@coreloom/ui';
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
							? 'Confirm why this submitted claim is approved.'
							: 'Explain why this submitted claim is rejected.'}
					</small>
				</div>
				<FormField label="Decision comment" required>
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
			<small>This decision is recorded with the claim.</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>Cancel</Button>
				<Button
					variant={approving ? 'primary' : 'danger'}
					type="submit"
					disabled={props.busy}
				>
					{props.busy
						? approving
							? 'Approving…'
							: 'Rejecting…'
						: approving
							? 'Approve claim'
							: 'Reject claim'}
				</Button>
			</div>
		</div>
	</form>
}
