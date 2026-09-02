import { useEffect, useMemo } from 'octane';
import { Alert, Button, FormField } from '@coreloom/ui';
import { useTranslation } from '@coreloom/client';
import { cell, createStore, useValue } from 'segment-state';
import {
	acceptTenantInvitation,
	completeMfaChallenge,
	completePasswordReset,
	requestPasswordReset,
} from './api.ts';
import type { AuthClientState, AuthScreen } from './state.ts';

interface PublicFlowProps {
	readonly auth: AuthClientState;
	readonly passwordMinLength: number;
	onScreen(screen: AuthScreen): void;
}

function formValue(event: SubmitEvent, key: string): string {
	const value = new FormData(event.currentTarget as HTMLFormElement).get(key);
	return typeof value === 'string' ? value : '';
}

function createFlowState() {
	const store = createStore({
		busy: false,
		error: '',
		notice: '',
		token: '',
		tokenChecked: false,
	});
	return { store, state: store.state };
}

export function ForgotPasswordForm(props: PublicFlowProps) @{
	const { t } = useTranslation();
	const flow = useMemo(() => createFlowState(), []);
	const [busy, setBusy] = useValue(flow.state.busy);
	const [error, setError] = useValue(flow.state.error);
	const [notice, setNotice] = useValue(flow.state.notice);

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		setBusy(true);
		setError('');
		setNotice('');
		try {
			await requestPasswordReset(formValue(event, 'email'));
			setNotice(t('auth.security.passwordReset.accepted'));
		} catch (submitError) {
			setError(
				submitError instanceof Error
					? submitError.message
					: t('auth.error.failed'),
			);
		} finally {
			setBusy(false);
		}
	};

	<>
		<header>
			<span class="auth-kicker">{t('auth.security.passwordReset.kicker')}</span>
			<h2>{t('auth.security.passwordReset.requestTitle')}</h2>
			<p class="auth-card__sub">{t(
				'auth.security.passwordReset.requestDescription',
			)}</p>
		</header>
		<form class="auth-flow-form" onSubmit={submit}>
			<FormField label={t('auth.email')} required>
				<input
					class="ui-input"
					name="email"
					type="email"
					autocomplete="email"
					maxlength={254}
					required
				/>
			</FormField>
			@if (error) {
				<Alert>{error}</Alert>
			}
			@if (notice) {
				<Alert tone="info">{notice}</Alert>
			}
			<Button variant="primary" size="lg" type="submit" block disabled={busy}>
				{busy ? t('auth.common.wait') : t('auth.security.passwordReset.send')}
			</Button>
		</form>
		<div class="auth-switch">
			<button type="button" onClick={() => props.onScreen('sign-in')}>{t(
				'auth.signup.backToSignIn',
			)}</button>
		</div>
	</>
}

export function ResetPasswordForm(props: PublicFlowProps) @{
	const { t } = useTranslation();
	const flow = useMemo(() => createFlowState(), []);
	const [busy, setBusy] = useValue(flow.state.busy);
	const [error, setError] = useValue(flow.state.error);
	const [token, setToken] = useValue(flow.state.token);
	const [tokenChecked, setTokenChecked] = useValue(flow.state.tokenChecked);

	useEffect(() => {
		setToken(new URL(window.location.href).searchParams.get('token') ?? '');
		setTokenChecked(true);
	}, []);

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const password = formValue(event, 'password');
		const confirmation = formValue(event, 'passwordConfirmation');
		if (password !== confirmation) {
			setError(t('auth.security.passwordReset.mismatch'));
			return;
		}
		setBusy(true);
		setError('');
		try {
			await completePasswordReset(token, password);
			props.auth.store.act(
				(transaction) => transaction.set(
					props.auth.state.flowNotice,
					t('auth.security.passwordReset.completed'),
				),
				'auth/password-reset-complete',
			);
			props.onScreen('sign-in');
		} catch (submitError) {
			setError(
				submitError instanceof Error
					? submitError.message
					: t('auth.security.passwordReset.invalid'),
			);
		} finally {
			setBusy(false);
		}
	};

	<>
		<header>
			<span class="auth-kicker">{t('auth.security.passwordReset.kicker')}</span>
			<h2>{t('auth.security.passwordReset.completeTitle')}</h2>
			<p class="auth-card__sub">{t(
				'auth.security.passwordReset.completeDescription',
			)}</p>
		</header>
		@if (!tokenChecked) {
			<p class="ui-table__empty">{t('auth.security.link.checking')}</p>
		} @else if (!token) {
			<Alert>{t('auth.security.passwordReset.invalid')}</Alert>
		} @else {
			<form class="auth-flow-form" onSubmit={submit}>
				<FormField
					label={t('auth.security.passwordReset.newPassword')}
					help={t('auth.password.minimum', { count: props.passwordMinLength })}
					required
				>
					<input
						class="ui-input"
						name="password"
						type="password"
						autocomplete="new-password"
						minlength={props.passwordMinLength}
						maxlength={1024}
						required
					/>
				</FormField>
				<FormField
					label={t('auth.security.passwordReset.confirmPassword')}
					required
				>
					<input
						class="ui-input"
						name="passwordConfirmation"
						type="password"
						autocomplete="new-password"
						minlength={props.passwordMinLength}
						maxlength={1024}
						required
					/>
				</FormField>
				@if (error) {
					<Alert>{error}</Alert>
				}
				<Button variant="primary" size="lg" type="submit" block disabled={busy}>
					{busy ? t('auth.common.wait') : t('auth.security.passwordReset.save')}
				</Button>
			</form>
		}
		<div class="auth-switch">
			<button type="button" onClick={() => props.onScreen('sign-in')}>{t(
				'auth.signup.backToSignIn',
			)}</button>
		</div>
	</>
}

export function InvitationAcceptanceForm(props: PublicFlowProps) @{
	const { t } = useTranslation();
	const flow = useMemo(() => createFlowState(), []);
	const [busy, setBusy] = useValue(flow.state.busy);
	const [error, setError] = useValue(flow.state.error);
	const [token, setToken] = useValue(flow.state.token);
	const [tokenChecked, setTokenChecked] = useValue(flow.state.tokenChecked);

	useEffect(() => {
		setToken(new URL(window.location.href).searchParams.get('token') ?? '');
		setTokenChecked(true);
	}, []);

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		setBusy(true);
		setError('');
		try {
			await acceptTenantInvitation({
				token,
				displayName: formValue(event, 'displayName'),
				password: formValue(event, 'password'),
			});
			props.auth.store.act(
				(transaction) => transaction.set(
					props.auth.state.flowNotice,
					t('auth.security.invitation.accepted'),
				),
				'auth/invitation-accepted',
			);
			props.onScreen('sign-in');
		} catch (submitError) {
			setError(
				submitError instanceof Error
					? submitError.message
					: t('auth.security.invitation.invalid'),
			);
		} finally {
			setBusy(false);
		}
	};

	<>
		<header>
			<span class="auth-kicker">{t('auth.security.invitation.kicker')}</span>
			<h2>{t('auth.security.invitation.title')}</h2>
			<p class="auth-card__sub">{t('auth.security.invitation.description')}</p>
		</header>
		@if (!tokenChecked) {
			<p class="ui-table__empty">{t('auth.security.link.checking')}</p>
		} @else if (!token) {
			<Alert>{t('auth.security.invitation.invalid')}</Alert>
		} @else {
			<form class="auth-flow-form" onSubmit={submit}>
				<FormField label={t('auth.signup.fullName')} required>
					<input
						class="ui-input"
						name="displayName"
						autocomplete="name"
						minlength={2}
						maxlength={80}
						required
					/>
				</FormField>
				<FormField
					label={t('auth.password')}
					help={t('auth.password.minimum', { count: props.passwordMinLength })}
					required
				>
					<input
						class="ui-input"
						name="password"
						type="password"
						autocomplete="new-password"
						minlength={props.passwordMinLength}
						maxlength={1024}
						required
					/>
				</FormField>
				@if (error) {
					<Alert>{error}</Alert>
				}
				<Button variant="primary" size="lg" type="submit" block disabled={busy}>
					{busy ? t('auth.common.wait') : t('auth.security.invitation.accept')}
				</Button>
			</form>
		}
		<div class="auth-switch">
			<button type="button" onClick={() => props.onScreen('sign-in')}>{t(
				'auth.signup.backToSignIn',
			)}</button>
		</div>
	</>
}

export function MfaChallengeForm(props: PublicFlowProps) @{
	const { t } = useTranslation();
	const [recoveryMode, setRecoveryMode] = useValue(
		props.auth.state.mfaRecoveryMode,
	);
	const [error] = useValue(props.auth.state.error);
	const [status] = useValue(props.auth.state.status);

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const submitted = formValue(event, recoveryMode ? 'recoveryCode' : 'code');
		await completeMfaChallenge(
			props.auth,
			recoveryMode ? { recoveryCode: submitted } : { code: submitted },
		);
	};

	<>
		<header>
			<span class="auth-kicker">{t('auth.security.mfa.kicker')}</span>
			<h2>{t('auth.security.mfa.challengeTitle')}</h2>
			<p class="auth-card__sub">{t(
				'auth.security.mfa.challengeDescription',
			)}</p>
		</header>
		<form class="auth-flow-form" onSubmit={submit}>
			@if (recoveryMode) {
				<FormField label={t('auth.security.mfa.recoveryCode')} required>
					<input
						class="ui-input ui-mono"
						name="recoveryCode"
						autocomplete="one-time-code"
						maxlength={32}
						required
					/>
				</FormField>
			} @else {
				<FormField label={t('auth.security.mfa.code')} required>
					<input
						class="ui-input ui-mono"
						name="code"
						inputmode="numeric"
						autocomplete="one-time-code"
						pattern="[0-9]{6}"
						maxlength={6}
						required
					/>
				</FormField>
			}
			@if (error) {
				<Alert>{error}</Alert>
			}
			<Button
				variant="primary"
				size="lg"
				type="submit"
				block
				disabled={status === 'submitting'}
			>
				{status === 'submitting'
					? t('auth.common.wait')
					: t('auth.security.mfa.verify')}
			</Button>
		</form>
		<div class="auth-switch">
			<button type="button" onClick={() => setRecoveryMode(!recoveryMode)}>
				{recoveryMode
					? t('auth.security.mfa.useCode')
					: t('auth.security.mfa.useRecovery')}
			</button>
			<span>{' · '}</span>
			<button
				type="button"
				onClick={() => {
					props.auth.store.act((transaction) => {
						transaction.set(props.auth.state.mfaChallengeToken, '');
						transaction.set(props.auth.state.error, '');
					}, 'auth/mfa-cancel');
					props.onScreen('sign-in');
				}}
			>{t('auth.common.back')}</button>
		</div>
	</>
}
