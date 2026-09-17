import { useEffect, useState } from 'octane';
import { Alert, Button, Drawer, FormField, Select, Tag } from '@flowdular/ui';
import { t } from '@flowdular/client';
import type {
	ResearchAdaptersOverview,
	ResearchAdapterTestResult,
	ResearchAdapterView,
} from '../domain/types.ts';
import {
	configureAdapter,
	researchErrorMessage,
	testAdapter,
	type ResearchAdapterConfigurationInput,
	type ResearchCredentialInput,
} from './api.ts';
import {
	adapterLabel,
	attemptOutcomeLabel,
	attemptOutcomeTone,
	durationLabel,
	errorCodeLabel,
} from './presentation.ts';

export interface AdapterDrawerProps {
	readonly open: boolean;
	readonly view: ResearchAdapterView | null;
	readonly csrfToken: string;
	readonly onClose: () => void;
	readonly onSaved: (overview: ResearchAdaptersOverview) => void;
}

const JSON_DISABLED = 'RESEARCH_SEARXNG_JSON_DISABLED';

type CredentialChoice = 'keep' | 'none' | 'bearer' | 'basic';

export function AdapterDrawer(props: AdapterDrawerProps) @{
	const view = props.view;
	const key = view?.key ?? '';
	const remote = key === 'searxng' || key === 'firecrawl';
	const [baseUrl, setBaseUrl] = useState('');
	const [credential, setCredential] = useState<CredentialChoice>('keep');
	const [token, setToken] = useState('');
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [maxAttempts, setMaxAttempts] = useState('');
	const [timeoutMs, setTimeoutMs] = useState('');
	const [instanceId, setInstanceId] = useState('');
	const [fixturesPath, setFixturesPath] = useState('');
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const [query, setQuery] = useState('');
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<ResearchAdapterTestResult | null>(null);
	const [testError, setTestError] = useState('');

	useEffect(() => {
		if (!props.open || !view) return;
		setBaseUrl(view.configuration.baseUrl ?? '');
		setCredential('keep');
		setToken('');
		setUsername('');
		setPassword('');
		setMaxAttempts(String(view.maxAttempts));
		setTimeoutMs(String(view.timeoutMs));
		setInstanceId(view.configuration.connectorInstanceId ?? '');
		setFixturesPath(view.configuration.recordedFixturesPath ?? '');
		setError('');
		setResult(null);
		setTestError('');
	}, [props.open, key]);

	const credentialInput = (): ResearchCredentialInput | undefined => {
		if (credential === 'keep') return undefined;
		if (credential === 'none') return { kind: 'none' };
		if (credential === 'bearer') return { kind: 'bearer', token };
		return { kind: 'basic', username, password };
	};

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		if (!view) return;
		const attempts = Number(maxAttempts);
		const timeout = Number(timeoutMs);
		if (!Number.isInteger(attempts) || !Number.isInteger(timeout)) {
			setError(t('research.adapters.drawer.invalid'));
			return;
		}
		const secret = credentialInput();
		const input: ResearchAdapterConfigurationInput = {
			adapter: view.key,
			maxAttempts: attempts,
			timeoutMs: timeout,
			...(remote ? { baseUrl: baseUrl.trim() } : {}),
			...(remote && secret ? { credential: secret } : {}),
			...(key === 'connector'
				? { connectorInstanceId: instanceId.trim() }
				: {}),
			...(key === 'recorded'
				? { recordedFixturesPath: fixturesPath.trim() }
				: {}),
		};
		setSaving(true);
		setError('');
		try {
			props.onSaved(await configureAdapter(props.csrfToken, input));
			/* A saved secret is never shown again, so the field empties at once. */
			setCredential('keep');
			setToken('');
			setPassword('');
		} catch (failure) {
			setError(researchErrorMessage(failure, 'research.adapters.error.save'));
		} finally {
			setSaving(false);
		}
	};

	const runTest = async () => {
		if (!view || query.trim() === '') return;
		setTesting(true);
		setTestError('');
		setResult(null);
		try {
			setResult(await testAdapter(props.csrfToken, view.key, query.trim()));
		} catch (failure) {
			setTestError(
				researchErrorMessage(failure, 'research.adapters.error.test'),
			);
		} finally {
			setTesting(false);
		}
	};

	const credentialOptions = [
		{
			value: 'keep',
			label: t('research.adapters.drawer.credentialKeep'),
		},
		{
			value: 'none',
			label: t('research.adapters.drawer.credentialNone'),
		},
		{
			value: 'bearer',
			label: key === 'firecrawl'
				? t('research.adapters.drawer.credentialApiKey')
				: t('research.adapters.drawer.credentialBearer'),
		},
		...(key === 'searxng'
			? [
					{
						value: 'basic',
						label: t('research.adapters.drawer.credentialBasic'),
					},
				]
			: []),
	];
	const jsonDisabled =
		view?.lastErrorCode === JSON_DISABLED ||
			result?.errorCode === JSON_DISABLED;

	<Drawer
		open={props.open && view !== null}
		title={view
			? t('research.adapters.drawer.title', { label: adapterLabel(view.key) })
			: ''}
		subtitle={view ? t('research.adapters.description.' + view.key) : ''}
		onClose={props.onClose}
	>
		<form class="ui-drawer__form" onSubmit={submit}>
			<div class="ui-drawer__body">
				<div class="ui-form">
					@if (jsonDisabled) {
						<Alert tone="warning">{t(
							'research.adapters.jsonDisabledHint',
						)}</Alert>
					}
					@if (remote) {
						<>
							<FormField
								label={t('research.adapters.drawer.baseUrl')}
								required={key === 'searxng'}
								help={t('research.adapters.drawer.baseUrlHelp.' + key)}
							>
								<input
									class="ui-input ui-mono"
									type="url"
									value={baseUrl}
									maxLength={2048}
									placeholder={key === 'firecrawl'
										? 'https://api.firecrawl.dev'
										: 'https://search.example.org'}
									disabled={saving}
									onInput={(event) => setBaseUrl(event.currentTarget.value)}
								/>
							</FormField>
							<div class="ui-form__row">
								<Select
									id="research-adapter-credential"
									label={t('research.adapters.drawer.credential')}
									options={credentialOptions}
									value={credential}
									disabled={saving}
									onChange={(value) => setCredential(value as CredentialChoice)}
								/>
								<span class="research-adapter__credential">
									<Tag
										tone={view?.configuration.hasCredentials
											? 'success'
											: 'neutral'}
										dot
									>
										{view?.configuration.hasCredentials
											? t('research.adapters.drawer.credentialSet')
											: t('research.adapters.drawer.credentialUnset')}
									</Tag>
								</span>
							</div>
							@if (credential === 'bearer') {
								<FormField
									label={key === 'firecrawl'
										? t('research.adapters.drawer.apiKey')
										: t('research.adapters.drawer.token')}
									required
								>
									<input
										class="ui-input ui-mono"
										type="password"
										autoComplete="off"
										value={token}
										maxLength={4000}
										disabled={saving}
										onInput={(event) => setToken(event.currentTarget.value)}
									/>
								</FormField>
							}
							@if (credential === 'basic') {
								<div class="ui-form__row">
									<FormField
										label={t('research.adapters.drawer.username')}
										required
									>
										<input
											class="ui-input"
											autoComplete="off"
											value={username}
											maxLength={256}
											disabled={saving}
											onInput={(event) => setUsername(
												event.currentTarget.value,
											)}
										/>
									</FormField>
									<FormField
										label={t('research.adapters.drawer.password')}
										required
									>
										<input
											class="ui-input"
											type="password"
											autoComplete="off"
											value={password}
											maxLength={1024}
											disabled={saving}
											onInput={(event) => setPassword(
												event.currentTarget.value,
											)}
										/>
									</FormField>
								</div>
							}
						</>
					}
					@if (key === 'connector') {
						<FormField
							label={t('research.settings.connectorInstanceId.label')}
							help={t('research.settings.connectorInstanceId.description')}
						>
							<input
								class="ui-input ui-mono"
								value={instanceId}
								maxLength={128}
								disabled={saving}
								onInput={(event) => setInstanceId(event.currentTarget.value)}
							/>
						</FormField>
					}
					@if (key === 'recorded') {
						<FormField
							label={t('research.settings.recordedFixturesPath.label')}
							help={t('research.settings.recordedFixturesPath.description')}
						>
							<input
								class="ui-input ui-mono"
								value={fixturesPath}
								maxLength={1024}
								disabled={saving}
								onInput={(event) => setFixturesPath(event.currentTarget.value)}
							/>
						</FormField>
					}
					<div class="ui-form__row">
						<FormField
							label={t('research.adapters.drawer.maxAttempts')}
							help={t('research.adapters.drawer.maxAttemptsHelp')}
						>
							<input
								class="ui-input"
								type="number"
								min="1"
								max="5"
								value={maxAttempts}
								disabled={saving}
								onInput={(event) => setMaxAttempts(event.currentTarget.value)}
							/>
						</FormField>
						<FormField
							label={t('research.adapters.drawer.timeout')}
							help={key === 'direct'
								? t('research.settings.fetchTimeoutMs.description')
								: t('research.adapters.drawer.timeoutHelp')}
						>
							<input
								class="ui-input"
								type="number"
								min="1000"
								max={key === 'direct' ? '20000' : '60000'}
								value={timeoutMs}
								disabled={saving}
								onInput={(event) => setTimeoutMs(event.currentTarget.value)}
							/>
						</FormField>
					</div>
					@if (error !== '') {
						<Alert>{error}</Alert>
					}
					@if (key !== 'direct') {
						<section class="ui-form__section">
							<div class="ui-form__section-head">
								<b>{t('research.adapters.test.title')}</b>
								<small>{t('research.adapters.test.description')}</small>
							</div>
							<div class="ui-control-row">
								<input
									class="ui-input"
									aria-label={t('research.adapters.test.query')}
									placeholder={t('research.adapters.test.query')}
									value={query}
									maxLength={400}
									disabled={testing}
									onInput={(event) => setQuery(event.currentTarget.value)}
								/>
								<Button
									size="sm"
									disabled={testing || query.trim() === ''}
									onClick={() => void runTest()}
								>
									{testing
										? t('research.adapters.test.running')
										: t('research.adapters.test.run')}
								</Button>
							</div>
							@if (testError !== '') {
								<Alert>{testError}</Alert>
							}
							@if (result) {
								<div class="research-test" role="status">
									<Tag
										tone={result.outcome === 'ok'
											? 'success'
											: result.outcome === 'empty'
												? 'warning'
												: 'danger'}
										dot
									>{t('research.adapters.test.outcome.' + result.outcome)}</Tag>
									<span class="num">{durationLabel(result.durationMs)}</span>
									<span>{t('research.adapters.test.results', {
										count: result.resultCount,
									})}</span>
									@if (result.errorCode !== null) {
										<p class="ui-help ui-help--error">{errorCodeLabel(
											result.errorCode,
										)}</p>
									}
									<ul class="research-attempts">
										@for (const attempt of result.attempts; key attempt.adapter +
											':' +
											attempt.attempt +
											':' +
											attempt.createdAt) {
											<li>
												<Tag
													tone={attemptOutcomeTone(attempt.outcome)}
												>{attemptOutcomeLabel(attempt.outcome)}</Tag>
												<span class="num">{durationLabel(
													attempt.durationMs,
												)}</span>
												@if (attempt.errorCode !== null) {
													<span class="ui-mono">{attempt.errorCode}</span>
												}
											</li>
										}
									</ul>
								</div>
							}
						</section>
					}
				</div>
			</div>
			<div class="ui-drawer__foot">
				<Button onClick={props.onClose}>{t('research.common.close')}</Button>
				<Button variant="primary" type="submit" disabled={saving}>
					{saving
						? t('research.common.saving')
						: t('research.adapters.drawer.save')}
				</Button>
			</div>
		</form>
	</Drawer>
}
