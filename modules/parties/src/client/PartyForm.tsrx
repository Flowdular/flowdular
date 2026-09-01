import { Alert, Button, FormField } from '@coreloom/ui';

export interface PartyFormProps {
	readonly busy: boolean;
	readonly error: string;
	readonly onCancel: () => void;
	readonly onSubmit: (event: SubmitEvent) => void;
}

export function PartyForm(props: PartyFormProps) @{
	<form class="ui-drawer__form" onSubmit={props.onSubmit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<FormField label="Name" required>
					<input
						class="ui-input"
						name="name"
						minLength={2}
						maxLength={160}
						autoFocus
						required
					/>
				</FormField>
				<FormField label="Kind">
					<select class="ui-select" name="kind">
						<option value="customer">Customer</option>
						<option value="supplier">Supplier</option>
						<option value="both">Customer + supplier</option>
					</select>
				</FormField>
				<div class="ui-form__row">
					<FormField label="Email" help="Used for invoices and reminders.">
						<input class="ui-input" name="email" type="email" maxLength={254} />
					</FormField>
					<FormField label="Phone">
						<input class="ui-input" name="phone" type="tel" maxLength={40} />
					</FormField>
				</div>
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>Parties are shared by sales, purchasing, and finance.</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>Cancel</Button>
				<Button variant="primary" type="submit" disabled={props.busy}>
					{props.busy ? 'Creating…' : 'Create party'}
				</Button>
			</div>
		</div>
	</form>
}
