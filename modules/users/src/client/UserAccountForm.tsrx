import { Alert, Button, FormField } from '@coreloom/ui';
import { t } from '@coreloom/client';
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
				<FormField label={t('users.form.displayName')} required>
					<input
						class="ui-input"
						name="displayName"
						minlength={2}
						maxlength={80}
						autoFocus
						required
					/>
				</FormField>
				<FormField label={t('users.form.email')} required>
					<input
						class="ui-input"
						name="email"
						type="email"
						maxlength={254}
						required
					/>
				</FormField>
				<FormField
					label={t('users.form.initialPassword')}
					help={t('users.form.initialPasswordHelp', {
						min: props.passwordMinLength,
					})}
					required
				>
					<input
						class="ui-input"
						name="password"
						type="password"
						minlength={props.passwordMinLength}
						autocomplete="new-password"
						required
					/>
				</FormField>
				<FormField
					label={t('users.form.role')}
					help={props.canAssignOwner ? undefined : t('users.form.ownerOnly')}
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
			<small>{t('users.form.footer')}</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>{t('users.action.cancel')}</Button>
				<Button variant="primary" type="submit" disabled={props.busy}>
					{props.busy
						? t('users.action.creating')
						: t('users.action.createAccount')}
				</Button>
			</div>
		</div>
	</form>
}
