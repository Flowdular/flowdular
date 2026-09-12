import { applicationPath } from '@flowdular/client/routing';
import { useEffect, useMemo, type OctaneNode } from 'octane';
import { Seo } from '@octanejs/seo';
import { Alert, BrandMark, Button, FormField, Icon } from '@flowdular/ui';
import { restorePersistedLocale, useTranslation } from '@flowdular/client';
import { useValue } from 'segment-state';
import type { AuthPrincipal } from '../domain/types.ts';
import {
	checkWorkspaceAvailability,
	loadAuthConfiguration,
	loadSession,
	signIn,
	signOut,
	signUp,
	switchTenant,
} from './api.ts';
import { AuthBackdrop } from './AuthBackdrop.tsrx';
import { PasswordChangeRequired } from './PasswordChangeRequired.tsrx';
import {
	ForgotPasswordForm,
	InvitationAcceptanceForm,
	MfaChallengeForm,
	ResetPasswordForm,
} from './PublicAuthFlows.tsrx';
import { isValidWorkspaceSlug, slugifyWorkspaceName } from './slug.ts';
import {
	authPathForScreen,
	authScreenFromUrl,
	canonicalAuthLocation,
	createAuthClientState,
	isAuthRouteUrl,
	workspaceFromUrl,
	type AuthClientState,
	type AuthScreen,
	type WorkspaceSlugCheck,
} from './state.ts';
import { registerPublicAuthTranslations } from './translations.ts';
import './auth.css';

export interface AuthenticationCoreProps {
	initialScreen?: AuthScreen;
	renderAuthenticated: (principal: AuthPrincipal, controls: AuthenticationControls) => OctaneNode;
}

export interface AuthenticationControls {
	readonly csrfToken: string;
	signOut(): Promise<void>;
	switchTenant(tenantId: string): Promise<void>;
}

interface AuthenticationFormProps {
	auth: AuthClientState;
	screen: AuthScreen;
	pending: boolean;
	error: string;
	allowSignUp: boolean;
}

function value(form: FormData, key: string): string {
	const entry = form.get(key);
	return typeof entry === 'string' ? entry : '';
}

function providerLabel(provider: string): string {
	if (provider === 'google') return 'Google';
	if (provider === 'github') return 'GitHub';
	if (provider === 'microsoft') return 'Microsoft';
	if (provider === 'okta') return 'Okta';
	/* Every button here starts /api/auth/oidc/<id>/start. There is no SAML
   endpoint, so no id gets a SAML label. */
	if (provider === 'oidc') return 'OpenID Connect';
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function AuthenticationForm(props: AuthenticationFormProps) @{
	const { t } = useTranslation();
	const [signUpStep] = useValue(props.auth.state.signUpStep);
	const [workspaceName, setWorkspaceName] = useValue(
		props.auth.state.workspaceName,
	);
	const [workspaceSlug, setWorkspaceSlug] = useValue(
		props.auth.state.workspaceSlug,
	);
	const [workspaceSlugEdited, setWorkspaceSlugEdited] = useValue(
		props.auth.state.workspaceSlugEdited,
	);
	const [slugCheck, setSlugCheck] = useValue(
		props.auth.state.workspaceSlugCheck,
	);
	const [providerOptions] = useValue(props.auth.state.providerOptions);
	const [signInWorkspace, setSignInWorkspace] = useValue(
		props.auth.state.signInWorkspace,
	);
	const [signInWorkspaceName] = useValue(props.auth.state.signInWorkspaceName);
	const [workspaceFixed] = useValue(props.auth.state.signInWorkspaceFromUrl);
	const [emailConfirmation] = useValue(props.auth.state.emailConfirmation);
	const [confirmationEmail] = useValue(props.auth.state.confirmationEmail);
	const [passwordMinLength] = useValue(props.auth.state.passwordMinLength);
	const [flowNotice] = useValue(props.auth.state.flowNotice);

	const setStep = (step: 1 | 2 | 3) => {
		props.auth.store.act((transaction) => {
			transaction.set(props.auth.state.signUpStep, step);
			transaction.set(props.auth.state.error, '');
		}, 'auth/sign-up-step');
	};

	const changeScreen = (screen: AuthScreen) => {
		if (screen === 'sign-up' && !props.allowSignUp) return;
		props.auth.store.act((transaction) => {
			transaction.set(props.auth.state.screen, screen);
			transaction.set(props.auth.state.error, '');
			transaction.set(props.auth.state.signUpStep, 1);
		}, 'auth/screen');
		history.pushState(null, '', authPathForScreen(screen));
	};

	const submitWorkspaceStep = async (event: SubmitEvent) => {
		event.preventDefault();
		const slug = workspaceSlug.trim().toLowerCase();
		if (!isValidWorkspaceSlug(slug)) {
			setSlugCheck({
				status: 'unavailable',
				message: t('auth.signup.slug.invalid'),
			});
			return;
		}
		setSlugCheck({ status: 'checking', message: '' });
		try {
			const availability = await checkWorkspaceAvailability(slug);
			if (!availability.valid || !availability.available) {
				setSlugCheck({
					status: 'unavailable',
					message: availability.message ?? t('auth.signup.slug.taken'),
				});
				return;
			}
			const availableCheck: WorkspaceSlugCheck = {
				status: 'available',
				message: '',
			};
			props.auth.store.act((transaction) => {
				transaction.set(props.auth.state.workspaceSlug, slug);
				transaction.set(props.auth.state.workspaceSlugCheck, availableCheck);
				transaction.set(props.auth.state.signUpStep, 2);
				transaction.set(props.auth.state.error, '');
			}, 'auth/workspace-step');
		} catch (checkError) {
			setSlugCheck({
				status: 'unavailable',
				message: checkError instanceof Error
					? checkError.message
					: t('auth.signup.slug.error'),
			});
		}
	};

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		if (props.screen === 'sign-up') {
			await signUp(props.auth, {
				email: value(form, 'email'),
				password: value(form, 'password'),
				displayName: value(form, 'displayName'),
				organizationName: workspaceName.trim(),
				organizationSlug: workspaceSlug,
			});
		} else {
			const workspace = signInWorkspace.trim();
			await signIn(props.auth, {
				email: value(form, 'email'),
				password: value(form, 'password'),
				...(workspace === '' ? {} : { workspace }),
			});
		}
	};

	const slugError =
		slugCheck.status === 'unavailable' ? slugCheck.message : undefined;
	const slugHelp =
		slugCheck.status === 'checking'
			? t('auth.signup.slug.checking')
			: slugCheck.status === 'available'
				? t('auth.signup.slug.available')
				: t('auth.signup.slug.help');
	const seoTitle =
		props.screen === 'sign-up'
			? t('auth.signup.seo.title')
			: props.screen === 'forgot-password'
				? t('auth.security.passwordReset.requestTitle')
				: props.screen === 'reset-password'
					? t('auth.security.passwordReset.completeTitle')
					: props.screen === 'accept-invitation'
						? t('auth.security.invitation.title')
						: props.screen === 'mfa-challenge'
							? t('auth.security.mfa.challengeTitle')
							: t('auth.signin.seo.title');
	const seoDescription =
		props.screen === 'sign-up'
			? t('auth.signup.seo.description')
			: props.screen === 'forgot-password'
				? t('auth.security.passwordReset.requestDescription')
				: props.screen === 'reset-password'
					? t('auth.security.passwordReset.completeDescription')
					: props.screen === 'accept-invitation'
						? t('auth.security.invitation.description')
						: props.screen === 'mfa-challenge'
							? t('auth.security.mfa.challengeDescription')
							: t('auth.signin.seo.description');

	<main class="auth-page">
		<Seo title={seoTitle} description={seoDescription} />
		<section class="auth-story" aria-label={t('auth.story.label')}>
			<AuthBackdrop />
			<span class="auth-story__bg" aria-hidden="true">
				<BrandMark size={380} signature tone="inverse" />
			</span>
			<a class="auth-brand" href="/" aria-label={t('auth.brand.label')}>
				<BrandMark size={24} signature tone="inverse" />
				Flowdular
			</a>
			<div class="auth-story__copy">
				<span class="auth-kicker">{t('auth.story.kicker')}</span>
				<h1>{t('auth.story.title')}</h1>
				<p>{t('auth.story.description')}</p>
			</div>
			<footer>
				<span>{t('auth.story.foundation')}</span>
				<span>{t('auth.story.builtBy')}</span>
			</footer>
		</section>
		<section class="auth-form-panel">
			<div class="auth-card">
				@if (props.screen === 'forgot-password') {
					<ForgotPasswordForm
						auth={props.auth}
						passwordMinLength={passwordMinLength}
						onScreen={changeScreen}
					/>
				} @else if (props.screen === 'reset-password') {
					<ResetPasswordForm
						auth={props.auth}
						passwordMinLength={passwordMinLength}
						onScreen={changeScreen}
					/>
				} @else if (props.screen === 'accept-invitation') {
					<InvitationAcceptanceForm
						auth={props.auth}
						passwordMinLength={passwordMinLength}
						onScreen={changeScreen}
					/>
				} @else if (props.screen === 'mfa-challenge') {
					<MfaChallengeForm
						auth={props.auth}
						passwordMinLength={passwordMinLength}
						onScreen={changeScreen}
					/>
				} @else if (props.screen === 'sign-up') {
					<>
						<header>
							<span class="auth-kicker">{t('auth.signup.kicker')}</span>
							<h2>
								{signUpStep === 1
									? t('auth.signup.step.workspace.title')
									: signUpStep === 2
										? t('auth.signup.step.administrator.title')
										: t('auth.signup.step.confirmation.title')}
							</h2>
							<p class="auth-card__sub">
								{signUpStep === 1
									? t('auth.signup.step.workspace.description')
									: signUpStep === 2
										? t('auth.signup.step.administrator.description')
										: t('auth.signup.step.confirmation.description')}
							</p>
						</header>
						<ol class="auth-steps">
							<li
								class={[
									signUpStep === 1 && 'is-active',
									signUpStep > 1 && 'is-done',
								]}
							>
								<i aria-hidden="true">
									{signUpStep > 1 ? '✓' : '01'}
								</i>
								{t('auth.signup.step.workspace.label')}
							</li>
							<li
								class={[
									signUpStep === 2 && 'is-active',
									signUpStep > 2 && 'is-done',
								]}
							>
								<i aria-hidden="true">
									{signUpStep > 2 ? '✓' : '02'}
								</i>
								{t('auth.signup.step.administrator.label')}
							</li>
							@if (emailConfirmation) {
								<li class={[signUpStep === 3 && 'is-active']}>
									<i aria-hidden="true">03</i>
									{t('auth.signup.step.confirmation.label')}
								</li>
							}
						</ol>
						@if (signUpStep === 1) {
							<form
								style="display:grid;gap:14px"
								onSubmit={submitWorkspaceStep}
							>
								<FormField label={t('auth.signup.workspace.name')} required>
									<input
										class="ui-input"
										name="organizationName"
										type="text"
										autocomplete="organization"
										value={workspaceName}
										onInput={(event) => {
											const name = event.currentTarget.value;
											setWorkspaceName(name);
											if (!workspaceSlugEdited) {
												setWorkspaceSlug(slugifyWorkspaceName(name));
											}
											setSlugCheck({ status: 'idle', message: '' });
										}}
										minlength={2}
										maxlength={120}
										required
									/>
								</FormField>
								<FormField
									label={t('auth.signup.workspace.id')}
									required
									help={slugError === undefined ? slugHelp : undefined}
									error={slugError}
								>
									<input
										class={[
											'ui-input',
											slugError !== undefined && 'ui-input--error',
										]}
										name="organizationSlug"
										type="text"
										autocomplete="off"
										spellcheck={false}
										value={workspaceSlug}
										onInput={(event) => {
											setWorkspaceSlugEdited(true);
											setWorkspaceSlug(event.currentTarget.value.toLowerCase());
											setSlugCheck({ status: 'idle', message: '' });
										}}
										minlength={3}
										maxlength={48}
										required
									/>
								</FormField>
								<p class="auth-slug-preview">
									{t('auth.signup.workspace.address') + ' ' +
										applicationPath() +
										'/'}
									<b>
										{workspaceSlug || t('auth.signup.workspace.placeholder')}
									</b>
								</p>
								@if (props.error) {
									<Alert>{props.error}</Alert>
								}
								<Button
									variant="primary"
									size="lg"
									type="submit"
									block
									disabled={slugCheck.status === 'checking'}
								>
									{slugCheck.status === 'checking'
										? t('auth.signup.slug.checkingShort')
										: t('auth.common.continue')}
								</Button>
							</form>
						} @else if (signUpStep === 2) {
							<form style="display:grid;gap:14px" onSubmit={submit}>
								<FormField label={t('auth.signup.fullName')} required>
									<input
										class="ui-input"
										name="displayName"
										type="text"
										autocomplete="name"
										minlength={2}
										maxlength={80}
										required
									/>
								</FormField>
								<FormField label={t('auth.email')} required>
									<input
										class="ui-input"
										name="email"
										type="email"
										autocomplete="username"
										maxlength={254}
										required
									/>
								</FormField>
								<FormField
									label={t('auth.password')}
									required
									help={t('auth.password.minimum', { count: 12 })}
								>
									<input
										class="ui-input"
										name="password"
										type="password"
										autocomplete="new-password"
										minlength={12}
										required
									/>
								</FormField>
								@if (props.error) {
									<Alert>{props.error}</Alert>
								}
								<div class="auth-wizard-foot">
									<Button size="lg" onClick={() => setStep(1)}>{t(
										'auth.common.back',
									)}</Button>
									<Button
										variant="primary"
										size="lg"
										type="submit"
										disabled={props.pending}
									>
										{props.pending
											? t('auth.common.wait')
											: t('auth.signup.create')}
									</Button>
								</div>
							</form>
						} @else {
							<div class="auth-confirmation">
								<span class="auth-confirmation__icon">
									<Icon name="check" size={20} />
								</span>
								<p>
									{t('auth.signup.confirmation.created') + ' '}
									<b>{applicationPath() + '/' + workspaceSlug}</b>
									{'. ' + t('auth.signup.confirmation.sent') + ' '}
									<b>{confirmationEmail}</b>
									{t('auth.signup.confirmation.finish')}
								</p>
								<Button block onClick={() => changeScreen('sign-in')}>{t(
									'auth.signup.backToSignIn',
								)}</Button>
							</div>
						}
					</>
				} @else {
					<>
						<header>
							<span class="auth-kicker">{t('auth.signin.kicker')}</span>
							<h2>{t('auth.signin.title')}</h2>
							<p class="auth-card__sub">
								{signInWorkspaceName
									? t('auth.signin.workspace.entering', {
											workspace: signInWorkspaceName,
										})
									: t('auth.signin.description')}
							</p>
						</header>
						<form style="display:grid;gap:14px" onSubmit={submit}>
							@if (!workspaceFixed) {
								<FormField
									label={t('auth.signin.workspace.label')}
									help={t('auth.signin.workspace.help')}
								>
									<input
										class="ui-input"
										name="workspace"
										type="text"
										autocomplete="organization"
										spellcheck={false}
										maxlength={64}
										value={signInWorkspace}
										onInput={(event) => setSignInWorkspace(
											event.currentTarget.value.toLowerCase(),
										)}
										onChange={() => void loadAuthConfiguration(
											props.auth,
											signInWorkspace.trim(),
										)}
									/>
								</FormField>
							}
							<FormField label={t('auth.email')} required>
								<input
									class="ui-input"
									name="email"
									type="email"
									autocomplete="username"
									maxlength={254}
									required
								/>
							</FormField>
							<FormField label={t('auth.password')} required>
								<input
									class="ui-input"
									name="password"
									type="password"
									autocomplete="current-password"
									required
								/>
							</FormField>
							@if (props.error) {
								<Alert>{props.error}</Alert>
							}
							@if (flowNotice) {
								<Alert tone="info">{flowNotice}</Alert>
							}
							<Button
								variant="primary"
								size="lg"
								type="submit"
								block
								disabled={props.pending}
							>
								{props.pending
									? t('auth.common.wait')
									: t('auth.signin.submit')}
							</Button>
						</form>
						<button
							class="auth-text-action"
							type="button"
							onClick={() => changeScreen('forgot-password')}
						>{t('auth.security.passwordReset.forgot')}</button>
						@if (providerOptions.length > 0) {
							<div class="auth-providers">
								<span class="auth-providers__divider">{t(
									'auth.signin.orProvider',
								)}</span>
								@for (const provider of providerOptions; key provider.scope +
									':' +
									provider.key) {
									<a
										class="ui-btn ui-btn--secondary ui-btn--block"
										href={provider.startPath}
									>
										{provider.scope === 'platform'
											? providerLabel(provider.key)
											: provider.label}
									</a>
								}
							</div>
						}
					</>
				}
				@if (
					(props.screen === 'sign-in' || props.screen === 'sign-up') &&
						(props.screen === 'sign-up' || props.allowSignUp)
				) {
					<div class="auth-switch">
						<span>
							{props.screen === 'sign-up'
								? t('auth.switch.existing')
								: t('auth.switch.new')}
						</span>
						<button
							type="button"
							onClick={() => changeScreen(
								props.screen === 'sign-up' ? 'sign-in' : 'sign-up',
							)}
						>
							{props.screen === 'sign-up'
								? t('auth.signin.submit')
								: t('auth.signup.create')}
						</button>
					</div>
				}
			</div>
		</section>
	</main>
}

export function AuthenticationCore(props: AuthenticationCoreProps) @{
	registerPublicAuthTranslations();
	const auth = useMemo(() => createAuthClientState(props.initialScreen), [
		props.initialScreen,
	]);
	const [status] = useValue(auth.state.status);
	const [screen, setScreen] = useValue(auth.state.screen);
	const [principal] = useValue(auth.state.principal);
	const [csrfToken] = useValue(auth.state.csrfToken);
	const [allowSignUp] = useValue(auth.state.allowSignUp);
	const [passwordChangeRequired] = useValue(auth.state.passwordChangeRequired);
	const [passwordMinLength] = useValue(auth.state.passwordMinLength);
	const [error] = useValue(auth.state.error);

	useEffect(() => {
		/* The auth root is the first component to run in the browser, so the
   account's stored language applies to the sign-in screen too. */
		restorePersistedLocale();
		/* A sign-in link may name the workspace being entered; the screen then
   offers that workspace's providers instead of asking for it. */
		const requested = workspaceFromUrl(window.location.href);
		if (requested) {
			auth.store.act((transaction) => {
				transaction.set(auth.state.signInWorkspace, requested);
				transaction.set(auth.state.signInWorkspaceFromUrl, true);
			}, 'auth/workspace-from-url');
		}
		void loadAuthConfiguration(auth, requested).then(() => loadSession(auth));
		const synchronizePublicRoute = () => {
			const location = window.location.href;
			setScreen(authScreenFromUrl(location));
			if (isAuthRouteUrl(location)) {
				const canonical = canonicalAuthLocation(location);
				if (
					window.location.pathname + window.location.search +
						window.location.hash !==
						canonical
				) {
					history.replaceState(null, '', canonical);
				}
			}
		};
		synchronizePublicRoute();
		const onPopState = () => synchronizePublicRoute();
		// Screens that change what the principal carries (the workspace name,
		// a forced password change) ask for a reload instead of duplicating it.
		const onRefresh = () => void loadSession(auth);
		window.addEventListener('popstate', onPopState);
		window.addEventListener('flowdular:session-refresh', onRefresh);
		return () => {
			window.removeEventListener('popstate', onPopState);
			window.removeEventListener('flowdular:session-refresh', onRefresh);
		};
	}, [auth, setScreen]);

	useEffect(() => {
		if (status !== 'anonymous' || isAuthRouteUrl(window.location.href)) return;
		history.replaceState(null, '', authPathForScreen(screen));
	}, [screen, status]);

	useEffect(() => {
		if (status === 'checking') return;
		requestAnimationFrame(() => {
			window.dispatchEvent(new Event('flowdular:ready'));
		});
	}, [status]);

	<div class="auth-root">
		@if (status === 'checking') {
			<div class="auth-checking" role="status">
				<span class="auth-checking__mark">
					<BrandMark size={40} signature />
				</span>
			</div>
		} @else if (
			status === 'authenticated' && principal && passwordChangeRequired
		) {
			<PasswordChangeRequired
				email={principal.email}
				csrfToken={csrfToken}
				passwordMinLength={passwordMinLength}
				onChanged={() => loadSession(auth)}
				onSignOut={() => signOut(auth)}
			/>
		} @else if (status === 'authenticated' && principal) {
			<>
				{props.renderAuthenticated(principal, {
					csrfToken,
					signOut: () => signOut(auth),
					switchTenant: (tenantId) => switchTenant(auth, tenantId),
				})}
			</>
		} @else {
			<AuthenticationForm
				auth={auth}
				screen={screen}
				pending={status === 'submitting'}
				error={error}
				allowSignUp={allowSignUp}
			/>
		}
	</div>
}
