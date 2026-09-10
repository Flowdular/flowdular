import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	EmptyState,
	FormField,
	Icon,
	PageHeader,
	Tag,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { cell, createStore, useValue } from 'segment-state';
import {
	AuthClientApiError,
	confirmMfa,
	enrollMfa,
	loadMfaStatus,
	type MfaEnrollmentPayload,
	type MfaStatusPayload,
} from '../api.ts';

export interface SecurityViewProps {
	readonly csrfToken: string;
}

type SecurityStatus = 'loading' | 'idle' | 'submitting' | 'denied' | 'error';

function createSecurityState() {
	const store = createStore({
		status: cell<SecurityStatus>('loading'),
		factor: cell<MfaStatusPayload | null>(null),
		enrollment: cell<MfaEnrollmentPayload | null>(null),
		error: '',
		notice: '',
	});
	return { store, state: store.state };
}

function submittedCode(event: SubmitEvent): string {
	const value = new FormData(event.currentTarget as HTMLFormElement).get(
		'code',
	);
	return typeof value === 'string' ? value : '';
}

export function SecurityView(props: SecurityViewProps) @{
	const client = useMemo(() => createSecurityState(), []);
	const [status, setStatus] = useValue(client.state.status);
	const [factor, setFactor] = useValue(client.state.factor);
	const [enrollment, setEnrollment] = useValue(client.state.enrollment);
	const [error, setError] = useValue(client.state.error);
	const [notice, setNotice] = useValue(client.state.notice);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			setFactor(await loadMfaStatus());
			setStatus('idle');
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('auth.security.mfa.errorLoad'),
			);
			setStatus(
				loadError instanceof AuthClientApiError &&
				(loadError.status === 401 || loadError.status === 403)
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const beginEnrollment = async () => {
		setStatus('submitting');
		setError('');
		setNotice('');
		try {
			setEnrollment(await enrollMfa(props.csrfToken));
			setStatus('idle');
		} catch (enrollError) {
			setError(
				enrollError instanceof Error
					? enrollError.message
					: t('auth.security.mfa.errorEnroll'),
			);
			setStatus('idle');
		}
	};

	const confirm = async (event: SubmitEvent) => {
		event.preventDefault();
		if (!enrollment) return;
		setStatus('submitting');
		setError('');
		try {
			await confirmMfa(submittedCode(event), props.csrfToken);
			setFactor({ available: true, enrolled: true, pending: false });
			setEnrollment({
				secret: '',
				otpauthUrl: '',
				recoveryCodes: enrollment.recoveryCodes,
			});
			setNotice(t('auth.security.mfa.enabled'));
			setStatus('idle');
		} catch (confirmError) {
			setError(
				confirmError instanceof Error
					? confirmError.message
					: t('auth.security.mfa.errorConfirm'),
			);
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('auth.security.page.eyebrow')}
			title={t('auth.security.page.title')}
			description={t('auth.security.page.description')}
		>
			<Button
				size="sm"
				onClick={() => void refresh()}
				disabled={status === 'loading'}
			>
				<Icon name="refresh" size={14} />
				{t('auth.security.action.refresh')}
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('auth.security.denied.title')}>{t(
					'auth.security.denied.description',
				)}</EmptyState>
			</section>
		} @else if (status === 'loading' && factor === null) {
			<section class="ui-card">
				<p class="ui-table__empty">{t('auth.security.mfa.loading')}</p>
			</section>
		} @else {
			<>
				@if (error) {
					<Alert>{error}</Alert>
				}
				@if (notice) {
					<Alert tone="info">{notice}</Alert>
				}
				<section class="ui-card">
					<div class="ui-card__head">
						<span class="ui-card__title">
							{t('auth.security.mfa.title')}
							<small>{t('auth.security.mfa.description')}</small>
						</span>
						@if (factor?.enrolled) {
							<Tag tone="success" dot>{t('auth.security.mfa.active')}</Tag>
						}
					</div>
					<div class="ui-card__body auth-security-body">
						@if (!factor?.available) {
							<EmptyState
								icon="shield"
								title={t('auth.security.mfa.unavailableTitle')}
							>{t('auth.security.mfa.unavailableDescription')}</EmptyState>
						} @else if (enrollment) {
							<div class="auth-security-setup">
								@if (enrollment.secret) {
									<>
										<p>{t('auth.security.mfa.setupDescription')}</p>
										<a
											class="ui-btn ui-btn--secondary"
											href={enrollment.otpauthUrl}
										>{t('auth.security.mfa.openAuthenticator')}</a>
										<div>
											<small class="ui-label">{t(
												'auth.security.mfa.manualSecret',
											)}</small>
											<code
												class="auth-security-secret"
											>{enrollment.secret}</code>
										</div>
									</>
								}
								<div>
									<strong>{t('auth.security.mfa.recoveryCodesTitle')}</strong>
									<p>{t('auth.security.mfa.recoveryCodes')}</p>
									<ul class="auth-security-codes">
										@for (const recoveryCode of enrollment.recoveryCodes; key recoveryCode) {
											<li>
												<code>{recoveryCode}</code>
											</li>
										}
									</ul>
								</div>
								@if (enrollment.secret) {
									<form class="auth-security-confirm" onSubmit={confirm}>
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
										<Button
											variant="primary"
											type="submit"
											disabled={status === 'submitting'}
										>
											{status === 'submitting'
												? t('auth.common.wait')
												: t('auth.security.mfa.confirm')}
										</Button>
									</form>
								} @else {
									<Button onClick={() => setEnrollment(null)}>{t(
										'auth.security.mfa.codesSaved',
									)}</Button>
								}
							</div>
						} @else if (factor?.enrolled) {
							<EmptyState
								icon="shield"
								title={t('auth.security.mfa.enabledTitle')}
							>{t('auth.security.mfa.enabledDescription')}</EmptyState>
						} @else {
							<div class="auth-security-enable">
								<p>{t('auth.security.mfa.enableDescription')}</p>
								<Button
									variant="primary"
									disabled={status === 'submitting'}
									onClick={() => void beginEnrollment()}
								>
									{status === 'submitting'
										? t('auth.common.wait')
										: t('auth.security.mfa.start')}
								</Button>
							</div>
						}
					</div>
				</section>
			</>
		}
	</div>
}
