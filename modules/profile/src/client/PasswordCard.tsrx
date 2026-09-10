import { Alert, Button, FormField } from '@flowdular/ui';
import { t } from '@flowdular/client';
import type { PasswordFormValues } from './password.ts';

export interface PasswordCardProps {
	readonly saving: boolean;
	readonly error: string;
	readonly success: string;
	readonly onSubmit: (values: PasswordFormValues) => Promise<boolean>;
}

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

export function PasswordCard(props: PasswordCardProps) @{
	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const element = event.currentTarget as HTMLFormElement;
		const form = new FormData(element);
		const changed = await props.onSubmit({
			currentPassword: formValue(form, 'currentPassword'),
			newPassword: formValue(form, 'newPassword'),
			confirmation: formValue(form, 'confirmation'),
		});
		if (changed) element.reset();
	};

	<section class="ui-card">
		<div class="ui-card__head">
			<span class="ui-card__title">
				{t('profile.password.title')}
				<small>{t('profile.password.description')}</small>
			</span>
		</div>
		<form class="ui-form" onSubmit={submit}>
			<FormField label={t('profile.password.current')} required>
				<input
					class="ui-input"
					name="currentPassword"
					type="password"
					autocomplete="current-password"
					required
				/>
			</FormField>
			<FormField label={t('profile.password.new')} required>
				<input
					class="ui-input"
					name="newPassword"
					type="password"
					autocomplete="new-password"
					required
				/>
			</FormField>
			<FormField label={t('profile.password.confirm')} required>
				<input
					class="ui-input"
					name="confirmation"
					type="password"
					autocomplete="new-password"
					required
				/>
			</FormField>
			@if (props.error) {
				<Alert>{props.error}</Alert>
			} @else if (props.success) {
				<Alert tone="info">{props.success}</Alert>
			}
			<div class="ui-form__actions">
				<Button variant="primary" type="submit" disabled={props.saving}>
					{props.saving
						? t('profile.password.saving')
						: t('profile.password.save')}
				</Button>
			</div>
		</form>
	</section>
}
