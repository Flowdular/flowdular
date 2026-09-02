import { useMemo } from 'octane';
import { useTranslation } from '@coreloom/client';
import { Alert, BrandMark, Button, FormField } from '@coreloom/ui';
import { cell, createStore, useValue } from 'segment-state';

export interface PasswordChangeRequiredProps {
	readonly email: string;
	readonly csrfToken: string;
	readonly passwordMinLength: number;
	readonly onChanged: () => Promise<void> | void;
	readonly onSignOut: () => Promise<void> | void;
}

function field(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

/* Shown instead of the workspace after an administrative password reset. The
   temporary password proves possession; the new one replaces it through the
   same auth.core endpoint the profile screen uses. */
export function PasswordChangeRequired(props: PasswordChangeRequiredProps) @{
	const { t } = useTranslation();
	const form = useMemo(
		() => createStore({
			busy: cell(false),
			error: '',
		}),
		[],
	);
	const [busy, setBusy] = useValue(form.state.busy);
	const [error, setError] = useValue(form.state.error);

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const data = new FormData(event.currentTarget as HTMLFormElement);
		const newPassword = field(data, 'newPassword');
		if (newPassword !== field(data, 'confirmation')) {
			setError(t('auth.passwordChange.mismatch'));
			return;
		}
		setBusy(true);
		setError('');
		try {
			const response = await fetch('/api/auth/password', {
				method: 'POST',
				credentials: 'same-origin',
				headers: {
					'content-type': 'application/json',
					'x-csrf-token': props.csrfToken,
				},
				body: JSON.stringify({
					currentPassword: field(data, 'currentPassword'),
					newPassword,
				}),
			});
			if (!response.ok) {
				const body = await response.json() as {
					error?: { message?: string };
				};
				throw new Error(body.error?.message ?? t('auth.passwordChange.error'));
			}
			await props.onChanged();
		} catch (changeError) {
			setError(
				changeError instanceof Error
					? changeError.message
					: t('auth.passwordChange.error'),
			);
		} finally {
			setBusy(false);
		}
	};

	<main class="auth-page">
		<section class="auth-form-panel" style="grid-column:1 / -1">
			<div class="auth-card">
				<header>
					<span class="auth-kicker">
						<BrandMark size={18} />
						{' ' + t('auth.passwordChange.kicker')}
					</span>
					<h2>{t('auth.passwordChange.title')}</h2>
					<p class="auth-card__sub">{t('auth.passwordChange.description', {
						email: props.email,
					})}</p>
				</header>
				<form
					style="display:grid;gap:14px"
					onSubmit={(event) => void submit(event)}
				>
					<FormField label={t('auth.passwordChange.temporary')} required>
						<input
							class="ui-input"
							name="currentPassword"
							type="password"
							autocomplete="current-password"
							autoFocus
							required
						/>
					</FormField>
					<FormField
						label={t('auth.passwordChange.new')}
						help={t('auth.password.minimum', {
							count: props.passwordMinLength,
						})}
						required
					>
						<input
							class="ui-input"
							name="newPassword"
							type="password"
							minlength={props.passwordMinLength}
							autocomplete="new-password"
							required
						/>
					</FormField>
					<FormField label={t('auth.passwordChange.confirm')} required>
						<input
							class="ui-input"
							name="confirmation"
							type="password"
							minlength={props.passwordMinLength}
							autocomplete="new-password"
							required
						/>
					</FormField>
					@if (error) {
						<Alert>{error}</Alert>
					}
					<Button variant="primary" type="submit" block disabled={busy}>
						{busy
							? t('auth.passwordChange.saving')
							: t('auth.passwordChange.submit')}
					</Button>
					<Button
						block
						variant="ghost"
						onClick={() => void props.onSignOut()}
					>{t('auth.signOut')}</Button>
				</form>
			</div>
		</section>
	</main>
}
