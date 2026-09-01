import { useEffect, useMemo, type OctaneNode } from 'octane';
import { Seo } from '@octanejs/seo';
import { Alert, BrandMark, Button, FormField, Icon } from '@coreloom/ui';
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
import { isValidWorkspaceSlug, slugifyWorkspaceName } from './slug.ts';
import {
	authScreenFromUrl,
	createAuthClientState,
	type AuthClientState,
	type AuthScreen,
	type WorkspaceSlugCheck,
} from './state.ts';
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
	if (provider === 'saml') return 'SAML SSO';
	if (provider === 'oidc') return 'OpenID Connect';
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function AuthenticationForm(props: AuthenticationFormProps) @{
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
	const [signInProviders] = useValue(props.auth.state.signInProviders);
	const [emailConfirmation] = useValue(props.auth.state.emailConfirmation);
	const [confirmationEmail] = useValue(props.auth.state.confirmationEmail);

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
		history.pushState(null, '', screen === 'sign-up' ? '/sign-up' : '/sign-in');
	};

	const submitWorkspaceStep = async (event: SubmitEvent) => {
		event.preventDefault();
		const slug = workspaceSlug.trim().toLowerCase();
		if (!isValidWorkspaceSlug(slug)) {
			setSlugCheck({
				status: 'unavailable',
				message: 'Use 3 to 48 lowercase letters, digits, and single hyphens; start and end with a letter or digit.',
			});
			return;
		}
		setSlugCheck({ status: 'checking', message: '' });
		try {
			const availability = await checkWorkspaceAvailability(slug);
			if (!availability.valid || !availability.available) {
				setSlugCheck({
					status: 'unavailable',
					message: availability.message ??
						'This workspace id is already taken. Pick another one.',
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
					: 'Availability check failed.',
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
			await signIn(props.auth, {
				email: value(form, 'email'),
				password: value(form, 'password'),
			});
		}
	};

	const slugError =
		slugCheck.status === 'unavailable' ? slugCheck.message : undefined;
	const slugHelp =
		slugCheck.status === 'checking'
			? 'Checking availability…'
			: slugCheck.status === 'available'
				? 'This workspace id is available.'
				: 'Lowercase letters, digits, and single hyphens.';

	<main class="auth-page">
		<Seo
			title={props.screen === 'sign-up' ? 'Create workspace' : 'Sign in'}
			description={props.screen === 'sign-up'
				? 'Create a Coreloom workspace and its first administrator account.'
				: 'Sign in to your Coreloom business workspace.'}
		/>
		<section class="auth-story" aria-label="Product introduction">
			<AuthBackdrop />
			<span class="auth-story__bg" aria-hidden="true">
				<BrandMark size={380} signature tone="inverse" />
			</span>
			<a
				class="auth-brand"
				href="/sign-in"
				aria-label="Coreloom authentication"
			>
				<BrandMark size={24} signature tone="inverse" />
				Coreloom
			</a>
			<div class="auth-story__copy">
				<span class="auth-kicker">Agentic foundation framework</span>
				<h1>Your business platform, built on a ready foundation.</h1>
				<p>
					Coreloom ships the core: accounts, workspaces, permissions, modules,
					and agents. You add the capabilities your business needs, in the
					sandbox with AI specialists or with skills inside your own tools.
				</p>
			</div>
			<footer>
				<span>Foundation by Coreloom</span>
				<span>Built by you</span>
			</footer>
		</section>
		<section class="auth-form-panel">
			<div class="auth-card">
				@if (props.screen === 'sign-up') {
					<>
						<header>
							<span class="auth-kicker">New workspace</span>
							<h2>
								{signUpStep === 1
									? 'Name your workspace'
									: signUpStep === 2
										? 'Create the administrator'
										: 'Confirm your email'}
							</h2>
							<p class="auth-card__sub">
								{signUpStep === 1
									? 'The workspace id becomes part of your workspace address.'
									: signUpStep === 2
										? 'The first account owns the workspace and everything built on it.'
										: 'One more step before you can sign in.'}
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
								Workspace
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
								Administrator
							</li>
							@if (emailConfirmation) {
								<li class={[signUpStep === 3 && 'is-active']}>
									<i aria-hidden="true">03</i>
									Confirmation
								</li>
							}
						</ol>
						@if (signUpStep === 1) {
							<form
								style="display:grid;gap:14px"
								onSubmit={submitWorkspaceStep}
							>
								<FormField label="Workspace name" required>
									<input
										class="ui-input"
										name="organizationName"
										type="text"
										autoComplete="organization"
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
									label="Workspace id"
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
										autoComplete="off"
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
									{'Workspace address: /'}
									<b>{workspaceSlug || 'your-workspace'}</b>
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
									{slugCheck.status === 'checking' ? 'Checking…' : 'Continue'}
								</Button>
							</form>
						} @else if (signUpStep === 2) {
							<form style="display:grid;gap:14px" onSubmit={submit}>
								<FormField label="Full name" required>
									<input
										class="ui-input"
										name="displayName"
										type="text"
										autoComplete="name"
										minlength={2}
										maxlength={80}
										required
									/>
								</FormField>
								<FormField label="Email address" required>
									<input
										class="ui-input"
										name="email"
										type="email"
										autoComplete="username"
										maxlength={254}
										required
									/>
								</FormField>
								<FormField
									label="Password"
									required
									help="At least 12 characters."
								>
									<input
										class="ui-input"
										name="password"
										type="password"
										autoComplete="new-password"
										minlength={12}
										required
									/>
								</FormField>
								@if (props.error) {
									<Alert>{props.error}</Alert>
								}
								<div class="auth-wizard-foot">
									<Button size="lg" onClick={() => setStep(1)}>Back</Button>
									<Button
										variant="primary"
										size="lg"
										type="submit"
										disabled={props.pending}
									>
										{props.pending ? 'Please wait…' : 'Create workspace'}
									</Button>
								</div>
							</form>
						} @else {
							<div class="auth-confirmation">
								<span class="auth-confirmation__icon">
									<Icon name="check" size={20} />
								</span>
								<p>
									{'We created '}
									<b>{'/' + workspaceSlug}</b>
									{'. Confirm your email address using the link sent to '}
									<b>{confirmationEmail}</b>
									{', then sign in.'}
								</p>
								<Button block onClick={() => changeScreen('sign-in')}>
									Back to sign in
								</Button>
							</div>
						}
					</>
				} @else {
					<>
						<header>
							<span class="auth-kicker">Welcome back</span>
							<h2>Sign in to continue</h2>
							<p class="auth-card__sub">
								Sign in with your workspace account.
							</p>
						</header>
						<form style="display:grid;gap:14px" onSubmit={submit}>
							<FormField label="Email address" required>
								<input
									class="ui-input"
									name="email"
									type="email"
									autoComplete="username"
									maxlength={254}
									required
								/>
							</FormField>
							<FormField label="Password" required>
								<input
									class="ui-input"
									name="password"
									type="password"
									autoComplete="current-password"
									required
								/>
							</FormField>
							@if (props.error) {
								<Alert>{props.error}</Alert>
							}
							<Button
								variant="primary"
								size="lg"
								type="submit"
								block
								disabled={props.pending}
							>
								{props.pending ? 'Please wait…' : 'Sign in'}
							</Button>
						</form>
						@if (signInProviders.length > 0) {
							<div class="auth-providers">
								<span class="auth-providers__divider">or continue with</span>
								@for (const provider of signInProviders; key provider) {
									<a
										class="ui-btn ui-btn--secondary ui-btn--block"
										href={'/api/auth/sso/' + provider + '/start'}
									>{providerLabel(provider)}</a>
								}
							</div>
						}
					</>
				}
				@if (props.screen === 'sign-up' || props.allowSignUp) {
					<div class="auth-switch">
						<span>
							{props.screen === 'sign-up'
								? 'Already have an account?'
								: 'New to Coreloom?'}
						</span>
						<button
							type="button"
							onClick={() => changeScreen(
								props.screen === 'sign-up' ? 'sign-in' : 'sign-up',
							)}
						>
							{props.screen === 'sign-up' ? 'Sign in' : 'Create a workspace'}
						</button>
					</div>
				}
			</div>
		</section>
	</main>
}

export function AuthenticationCore(props: AuthenticationCoreProps) @{
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
		void loadAuthConfiguration(auth).then(() => loadSession(auth));
		const onPopState = () => setScreen(authScreenFromUrl(window.location.href));
		// Screens that change what the principal carries (the workspace name,
		// a forced password change) ask for a reload instead of duplicating it.
		const onRefresh = () => void loadSession(auth);
		window.addEventListener('popstate', onPopState);
		window.addEventListener('coreloom:session-refresh', onRefresh);
		return () => {
			window.removeEventListener('popstate', onPopState);
			window.removeEventListener('coreloom:session-refresh', onRefresh);
		};
	}, [auth, setScreen]);

	useEffect(() => {
		if (status === 'checking') return;
		requestAnimationFrame(() => {
			window.dispatchEvent(new Event('coreloom:ready'));
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
