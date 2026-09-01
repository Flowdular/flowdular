import { Alert, Button, FormField } from '@coreloom/ui';
import type { UserDirectory } from '../services/users-service.ts';

export interface UserAccountFormProps {
	readonly roles: UserDirectory['roles'];
	readonly canAssignOwner: boolean;
	readonly passwordMinLength: number;
	readonly busy: boolean;
	readonly error: string;
	readonly onCancel: () => void;
	readonly onSubmit: (event: SubmitEvent) => void;
}

export function UserAccountForm(props: UserAccountFormProps) @{
	<form class="ui-drawer__form" onSubmit={props.onSubmit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<FormField label="Display name" required>
					<input
						class="ui-input"
						name="displayName"
						minLength={2}
						maxLength={80}
						autoFocus
						required
					/>
				</FormField>
				<FormField label="Email" required>
					<input
						class="ui-input"
						name="email"
						type="email"
						maxLength={254}
						required
					/>
				</FormField>
				<FormField
					label="Initial password"
					help={'At least ' + props.passwordMinLength +
						' characters. The account holder can change it later.'}
					required
				>
					<input
						class="ui-input"
						name="password"
						type="password"
						minLength={props.passwordMinLength}
						autoComplete="new-password"
						required
					/>
				</FormField>
				<FormField
					label="Role"
					help={props.canAssignOwner
						? undefined
						: 'Only an owner can create another owner.'}
				>
					<select class="ui-select" name="role">
						@for (const role of props.roles; key role.id) {
							@if (role.key !== 'owner' || props.canAssignOwner) {
								<option
									value={role.key}
									selected={role.key === 'member'}
								>{role.name}</option>
							}
						}
					</select>
				</FormField>
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>The account gets access to the current workspace only.</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>Cancel</Button>
				<Button variant="primary" type="submit" disabled={props.busy}>
					{props.busy ? 'Creating…' : 'Create account'}
				</Button>
			</div>
		</div>
	</form>
}
