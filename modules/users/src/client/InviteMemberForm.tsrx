import { Alert, Button, FormField } from '@flowdular/ui';
import { t } from '@flowdular/client';
import type { UserDirectory } from '../services/users-service.ts';

export interface InviteMemberFormProps {
	readonly roles: UserDirectory['roles'];
	readonly canAssignOwner: boolean;
	readonly busy: boolean;
	readonly error: string;
	readonly onCancel: () => void;
	readonly onSubmit: (event: SubmitEvent) => void;
}

export function InviteMemberForm(props: InviteMemberFormProps) @{
	<form class="ui-drawer__form" onSubmit={props.onSubmit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<FormField
					label={t('users.invite.email')}
					help={t('users.invite.emailHelp')}
					required
				>
					<input
						class="ui-input"
						name="email"
						type="email"
						autocomplete="email"
						maxlength={254}
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
			<small>{t('users.invite.footer')}</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>{t('users.action.cancel')}</Button>
				<Button variant="primary" type="submit" disabled={props.busy}>
					{props.busy ? t('users.invite.sending') : t('users.invite.send')}
				</Button>
			</div>
		</div>
	</form>
}
