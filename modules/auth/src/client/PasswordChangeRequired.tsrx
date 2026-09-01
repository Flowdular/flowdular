import { useMemo } from 'octane';
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
			setError('The new password and its confirmation differ.');
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
				throw new Error(body.error?.message ?? 'The password was not changed.');
			}
			await props.onChanged();
		} catch (changeError) {
			setError(
				changeError instanceof Error
					? changeError.message
					: 'The password was not changed.',
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
						{' Password reset'}
					</span>
					<h2>Choose a new password</h2>
					<p class="auth-card__sub">
						{'An administrator reset the password for ' + props.email +
							'. Pick a new one to continue.'}
					</p>
				</header>
				<form
					style="display:grid;gap:14px"
					onSubmit={(event) => void submit(event)}
				>
					<FormField label="Temporary password" required>
						<input
							class="ui-input"
							name="currentPassword"
							type="password"
							autoComplete="current-password"
							autoFocus
							required
						/>
					</FormField>
					<FormField
						label="New password"
						help={'At least ' + props.passwordMinLength + ' characters.'}
						required
					>
						<input
							class="ui-input"
							name="newPassword"
							type="password"
							minLength={props.passwordMinLength}
							autoComplete="new-password"
							required
						/>
					</FormField>
					<FormField label="Confirm new password" required>
						<input
							class="ui-input"
							name="confirmation"
							type="password"
							minLength={props.passwordMinLength}
							autoComplete="new-password"
							required
						/>
					</FormField>
					@if (error) {
						<Alert>{error}</Alert>
					}
					<Button variant="primary" type="submit" block disabled={busy}>
						{busy ? 'Saving…' : 'Set new password'}
					</Button>
					<Button block variant="ghost" onClick={() => void props.onSignOut()}>
						Sign out
					</Button>
				</form>
			</div>
		</section>
	</main>
}
