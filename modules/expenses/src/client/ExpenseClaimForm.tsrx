import { useMemo } from 'octane';
import { Alert, Button, FormField } from '@coreloom/ui';
import { createStore, useValue } from 'segment-state';

export interface ExpenseClaimFormProps {
	readonly busy: boolean;
	readonly error: string;
	readonly onCancel: () => void;
	readonly onSubmit: (event: SubmitEvent) => void;
}

export function ExpenseClaimForm(props: ExpenseClaimFormProps) @{
	const formState = useMemo(() => createStore({ currency: 'EUR' }), []);
	const [currency, setCurrency] = useValue(formState.state.currency);

	<form class="ui-drawer__form" onSubmit={props.onSubmit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<div class="ui-form__row">
					<FormField label="Title" required>
						<input
							class="ui-input"
							name="title"
							maxlength={160}
							autoFocus
							required
						/>
					</FormField>
					<FormField
						label="Amount"
						help="Use up to two decimal places, for example 12.50."
						required
					>
						<input
							class="ui-input"
							name="amount"
							type="number"
							min="0"
							step="0.01"
							required
						/>
					</FormField>
				</div>
				<div class="ui-form__row">
					<FormField label="Currency" required>
						<input
							class="ui-input ui-mono"
							name="currency"
							value={currency}
							onInput={(event) => setCurrency(
								event.currentTarget.value.toUpperCase(),
							)}
							minlength={3}
							maxlength={3}
							required
						/>
					</FormField>
					<FormField label="Category" required>
						<select class="ui-select" name="category" required>
							<option value="travel">Travel</option>
							<option value="meals">Meals</option>
							<option value="equipment">Equipment</option>
							<option value="other">Other</option>
						</select>
					</FormField>
				</div>
				<div class="ui-form__row">
					<FormField label="Expense date" required>
						<input class="ui-input" name="expenseDate" type="date" required />
					</FormField>
				</div>
				<FormField label="Note" help="Optional, up to 2,000 characters.">
					<textarea class="ui-textarea" name="note" maxlength={2000}></textarea>
				</FormField>
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>The claim is saved as a draft and can be submitted later.</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>Cancel</Button>
				<Button variant="primary" type="submit" disabled={props.busy}>
					{props.busy ? 'Creating…' : 'Create claim'}
				</Button>
			</div>
		</div>
	</form>
}
