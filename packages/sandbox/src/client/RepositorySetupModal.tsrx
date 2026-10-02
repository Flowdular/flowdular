import { useEffect, useRef, useState } from 'octane';
import { Alert, Button, Drawer, FormField } from '@flowdular/ui';
import {
	applyApplicationRepository,
	cancelPendingApplicationRepository,
	loadPendingApplicationRepository,
	planApplicationRepository,
	type RepositorySetupMode,
	type RepositorySetupOutcome,
	type RepositorySetupPlan,
} from './api.ts';
import { useTranslation } from './i18n.ts';

export interface RepositorySetupModalProps {
	readonly onClose: () => void;
	readonly onComplete: (outcome: RepositorySetupOutcome) => void;
}

export function RepositorySetupModal(props: RepositorySetupModalProps) @{
	const { t } = useTranslation();
	const [mode, setMode] = useState<RepositorySetupMode>('create');
	const [repository, setRepository] = useState('');
	const [plan, setPlan] = useState<RepositorySetupPlan | null>(null);
	const [token, setToken] = useState('');
	const [outcome, setOutcome] = useState<RepositorySetupOutcome | null>(null);
	const [busy, setBusy] = useState(false);
	const [pendingLoading, setPendingLoading] = useState(true);
	const [pending, setPending] = useState<RepositorySetupPlan | null>(null);
	const [pendingError, setPendingError] = useState('');
	const [error, setError] = useState('');
	const mounted = useRef(true);

	const refreshPending = async (prefill: boolean = false) => {
		setPendingLoading(true);
		setPendingError('');
		try {
			const result = await loadPendingApplicationRepository();
			if (!mounted.current) return;
			setPending(result.pending);
			if (prefill && result.pending) {
				setMode(result.pending.mode);
				setRepository(result.pending.repository);
			}
		} catch (failure) {
			if (!mounted.current) return;
			setPendingError(
				failure instanceof Error
					? failure.message
					: t('sandbox.repository.error.pending'),
			);
		} finally {
			if (mounted.current) setPendingLoading(false);
		}
	};

	useEffect(() => {
		mounted.current = true;
		void refreshPending(true);
		return () => {
			mounted.current = false;
		};
	}, []);

	const changeInput = () => {
		setPlan(null);
		setToken('');
		setError('');
	};
	const review = async (event: SubmitEvent) => {
		event.preventDefault();
		setBusy(true);
		setError('');
		try {
			const result = await planApplicationRepository(mode, repository.trim());
			setPlan(result.plan);
			setToken(result.token);
		} catch (failure) {
			setPlan(null);
			setToken('');
			setError(
				failure instanceof Error
					? failure.message
					: t('sandbox.repository.error.plan'),
			);
			await refreshPending();
		} finally {
			setBusy(false);
		}
	};
	const publish = async () => {
		if (!plan || !token) return;
		setBusy(true);
		setError('');
		try {
			const result = await applyApplicationRepository(token);
			setOutcome(result.outcome);
			setPlan(null);
			setToken('');
			props.onComplete(result.outcome);
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: t('sandbox.repository.error.publish'),
			);
			/* The server retains a completed push if saving local settings failed,
   so this receipt can safely retry that last step. Another button
   prepares a new plan after any other partial failure. */
			await refreshPending();
		} finally {
			setBusy(false);
		}
	};
	const cancelPending = async () => {
		if (!pending || pending.mode !== 'create' || busy || pendingLoading) return;
		setBusy(true);
		setError('');
		try {
			await cancelPendingApplicationRepository(pending.repository);
			setPlan(null);
			setToken('');
			setPending(null);
			await refreshPending();
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: t('sandbox.repository.error.cancel'),
			);
			await refreshPending();
		} finally {
			setBusy(false);
		}
	};
	const working = busy || pendingLoading;

	<Drawer
		open={true}
		title={t('sandbox.repository.title')}
		subtitle={t('sandbox.repository.description')}
		width="lg"
		onClose={() => {
			if (!busy) props.onClose();
		}}
	>
		<form class="ui-drawer__form" onSubmit={review}>
			<div class="ui-drawer__body">
				<div class="ui-form">
					@if (!outcome) {
						<>
							<FormField
								label={t('sandbox.repository.mode.label')}
								help={t('sandbox.repository.mode.help')}
							>
								<select
									class="ui-select"
									value={mode}
									disabled={working}
									onChange={(event) => {
										setMode(event.currentTarget.value as RepositorySetupMode);
										changeInput();
									}}
								>
									<option value="create">{t(
										'sandbox.repository.mode.create',
									)}</option>
									<option value="connect">{t(
										'sandbox.repository.mode.connect',
									)}</option>
								</select>
							</FormField>
							<FormField
								label={t('sandbox.repository.name.label')}
								help={t('sandbox.repository.name.help')}
							>
								<input
									class="ui-input ui-mono"
									type="text"
									value={repository}
									disabled={working}
									onInput={(event) => {
										setRepository(event.currentTarget.value);
										changeInput();
									}}
									placeholder={t('sandbox.repository.name.placeholder')}
									maxLength={160}
									required
								/>
							</FormField>
							@if (pending) {
								<div class="ui-form__section">
									<div class="ui-form__section-head">
										<b>{t('sandbox.repository.pending.title')}</b>
									</div>
									<p class="ui-mono">{pending.repository}</p>
									<Alert tone="warning">{t(
										pending.mode === 'create'
											? 'sandbox.repository.pending.help'
											: 'sandbox.repository.pending.connectHelp',
									)}</Alert>
									@if (pending.mode === 'create') {
										<p id="repository-pending-safety" class="ui-help">{t(
											'sandbox.repository.pending.cancelSafety',
										)}</p>
									}
								</div>
							}
							<Alert tone="info">
								{plan?.resuming
									? t('sandbox.repository.resumeSafety')
									: t('sandbox.repository.safety')}
							</Alert>
							@if (plan) {
								<div class="ui-form__section">
									<div class="ui-form__section-head">
										<b>{t(
											plan.resuming
												? 'sandbox.repository.plan.resumeTitle'
												: 'sandbox.repository.plan.title',
										)}</b>
										<small>{t(
											plan.resuming
												? 'sandbox.repository.plan.resumeHelp'
												: 'sandbox.repository.plan.help',
										)}</small>
									</div>
									<p>
										{plan.resuming
											? t('sandbox.repository.plan.resume')
											: plan.mode === 'create'
												? t('sandbox.repository.plan.create')
												: t('sandbox.repository.plan.connect')}
									</p>
									<p class="ui-mono">{plan.repository}</p>
									<p>{t(
										plan.resuming
											? 'sandbox.repository.plan.resumeCommit'
											: 'sandbox.repository.plan.push',
										{
											remote: plan.remote,
											branch: plan.branch,
											head: plan.head.slice(0, 12),
										},
									)}</p>
									<p class="ui-help">{t('sandbox.repository.plan.origin')}</p>
								</div>
							}
						</>
					} @else {
						<Alert tone="info">
							{t('sandbox.repository.success')}
							{' '}
							<a
								href={outcome.url}
								target="_blank"
								rel="noopener noreferrer"
							>{outcome.repository}</a>
						</Alert>
					}
					@if (error) {
						<Alert tone="danger">{error}</Alert>
					}
					@if (pendingError) {
						<Alert tone="danger">{pendingError}</Alert>
					}
				</div>
			</div>
			<div class="ui-drawer__foot">
				<small>{t('sandbox.repository.footer')}</small>
				<div class="ui-form__actions">
					<Button type="button" onClick={props.onClose} disabled={busy}>
						{outcome ? t('sandbox.common.close') : t('sandbox.common.cancel')}
					</Button>
					@if (!outcome) {
						<>
							@if (pending?.mode === 'create') {
								<Button
									type="button"
									variant="danger"
									disabled={working}
									describedBy="repository-pending-safety"
									onClick={() => void cancelPending()}
								>{t('sandbox.repository.pending.cancel')}</Button>
							}
							@if (!plan) {
								<Button type="submit" variant="primary" disabled={working}>
									{working
										? t('sandbox.repository.checking')
										: t('sandbox.repository.review')}
								</Button>
							} @else {
								<>
									@if (error) {
										<Button type="submit" disabled={working}>{t(
											'sandbox.repository.reviewAgain',
										)}</Button>
									}
									<Button
										type="button"
										variant="primary"
										disabled={working}
										onClick={() => void publish()}
									>
										{working
											? t('sandbox.repository.publishing')
											: plan.resuming
												? t('sandbox.repository.resume')
												: plan.mode === 'create'
													? t('sandbox.repository.createAndPush')
													: t('sandbox.repository.connectAndPush')}
									</Button>
								</>
							}
						</>
					}
				</div>
			</div>
		</form>
	</Drawer>
}
