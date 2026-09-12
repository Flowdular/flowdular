import { useMemo } from 'octane';
import {
	Alert,
	Button,
	EmptyState,
	FormField,
	Select,
	Switch,
	Tag,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import { cell, createStore, useValue } from 'segment-state';
import {
	CONNECTOR_AUTH_KINDS,
	type ConnectorAuthKind,
	type ConnectorDefinition,
	type ConnectorInstance,
} from '../domain/types.ts';
import type { ConnectorFormValue } from './api.ts';
import {
	CONNECTOR_CALLER_KINDS,
	consentGranted,
	type ConnectorCallerKind,
	type ConnectorFormState,
} from './consent.ts';
import {
	consentLabel,
	instanceStatusLabel,
	instanceStatusTone,
	timestampLabel,
} from './presentation.ts';
import type { TestCallReport } from './state.ts';

export interface ConnectorFormProps {
	readonly instance: ConnectorInstance | null;
	readonly definitions: readonly ConnectorDefinition[];
	readonly canManage: boolean;
	readonly busy: boolean;
	readonly error: string;
	readonly test: TestCallReport | null;
	/** Loading, denied and missing render instead of the form, never over it. */
	readonly state: ConnectorFormState;
	readonly onCancel: () => void;
	readonly onEnable: () => void;
	readonly onDisable: () => void;
	readonly onDelete: () => void;
	readonly onConsent: (kind: ConnectorCallerKind) => void;
	readonly onTestCall: (operation: string, path: string) => void;
	readonly onSubmit: (value: ConnectorFormValue) => void;
}

interface CredentialField {
	readonly key: string;
	readonly secret: boolean;
}

function stringValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value.trim() : '';
}

function hostList(value: string): readonly string[] {
	return value.split(/[\s,]+/).map((entry) => entry.trim()).filter(
		(entry) => entry.length > 0,
	);
}

function credentialFields(kind: ConnectorAuthKind): readonly CredentialField[] {
	if (kind === 'api-key') {
		return [
			{ key: 'header', secret: false },
			{ key: 'value', secret: true },
		];
	}
	if (kind === 'bearer') return [
		{ key: 'token', secret: true },
	];
	if (kind === 'oauth2-client-credentials') {
		return [
			{ key: 'tokenUrl', secret: false },
			{ key: 'clientId', secret: false },
			{ key: 'clientSecret', secret: true },
			{ key: 'scope', secret: false },
		];
	}
	return [];
}

export function ConnectorForm(props: ConnectorFormProps) @{
	const formState = useMemo(
		() => createStore({
			authKind: cell<ConnectorAuthKind>(props.instance?.authKind ?? 'none'),
			definitionKey: cell<string>(
				props.instance?.definitionKey ?? props.definitions[0]?.key ?? '',
			),
			operation: '',
			testPath: '/',
			/* A stored credential is never readable again, so an edit replaces it
   only when the owner asks to. */
			replaceCredentials: props.instance === null,
		}),
		[],
	);
	const [authKind, setAuthKind] = useValue(formState.state.authKind);
	const [definitionKey, setDefinitionKey] = useValue(
		formState.state.definitionKey,
	);
	const [operation, setOperation] = useValue(formState.state.operation);
	const [testPath, setTestPath] = useValue(formState.state.testPath);
	const [replaceCredentials, setReplaceCredentials] = useValue(
		formState.state.replaceCredentials,
	);
	const instance = props.instance;
	const editable = props.canManage && !props.busy;
	const activeKind = instance?.authKind ?? authKind;
	const definition =
		props.definitions.find(
			(candidate) =>
				candidate.key === (instance?.definitionKey ?? definitionKey),
		) ?? null;
	const operations = definition?.operations ?? [];
	const selectedOperation =
		operation === '' ? operations[0]?.key ?? '' : operation;

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const credentials: Record<string, unknown> = {};
		for (const field of credentialFields(activeKind)) {
			const value = stringValue(form, 'credential-' + field.key);
			if (value !== '') credentials[field.key] = value;
		}
		props.onSubmit({
			definitionKey: instance?.definitionKey ?? definitionKey,
			name: stringValue(form, 'name'),
			baseUrl: stringValue(form, 'baseUrl'),
			authKind: activeKind,
			allowedHosts: hostList(stringValue(form, 'allowedHosts')),
			credentials: instance !== null && !replaceCredentials
				? undefined
				: credentials,
		});
	};

	@if (props.state === 'loading') {
		<div class="ui-drawer__body">
			<EmptyState icon="refresh" title={t('connectors.form.loadingTitle')}>{t(
				'connectors.form.loadingHint',
			)}</EmptyState>
		</div>
	} @else if (props.state === 'denied') {
		<div class="ui-drawer__body">
			<EmptyState icon="shield" title={t('connectors.common.accessDenied')}>{t(
				'connectors.instances.denied',
			)}</EmptyState>
		</div>
	} @else if (props.state === 'missing') {
		<div class="ui-drawer__body">
			<EmptyState icon="search" title={t('connectors.form.missingTitle')}>{t(
				'connectors.form.missingHint',
			)}</EmptyState>
		</div>
	} @else {
		<form class="ui-drawer__form" onSubmit={submit}>
			<div class="ui-drawer__body">
				<div class="ui-form">
					@if (props.error) {
						<Alert>{props.error}</Alert>
					}
					@if (instance) {
						<>
							<div class="ui-control-row">
								<Tag
									tone={instanceStatusTone(instance.status)}
									dot
								>{instanceStatusLabel(instance.status)}</Tag>
							</div>
							@for (const kind of CONNECTOR_CALLER_KINDS; key kind) {
								<FormField
									label={t('connectors.consent.' + kind)}
									help={t('connectors.consent.' + kind + 'Help')}
								>
									<Switch
										label={t('connectors.consent.' + kind + 'Switch', {
											value: consentLabel(consentGranted(instance, kind)),
										})}
										checked={consentGranted(instance, kind)}
										disabled={!editable}
										onChange={() => props.onConsent(kind)}
									/>
								</FormField>
							}
						</>
					}
					<Select
						id="connectors-definition"
						label={t('connectors.form.definition')}
						help={t('connectors.form.definitionHelp')}
						value={instance?.definitionKey ?? definitionKey}
						options={props.definitions.map(
							(entry) => ({
								value: entry.key,
								label: entry.label,
							}),
						)}
						required
						disabled={!editable || instance !== null}
						onChange={(value) => setDefinitionKey(value)}
					/>
					<FormField
						label={t('connectors.form.name')}
						required
						help={t('connectors.form.nameHelp')}
					>
						<input
							class="ui-input"
							name="name"
							defaultValue={instance?.name ?? ''}
							placeholder={t('connectors.form.namePlaceholder')}
							maxlength={120}
							disabled={!editable}
							required
						/>
					</FormField>
					<FormField
						label={t('connectors.form.baseUrl')}
						required
						help={t('connectors.form.baseUrlHelp')}
					>
						<input
							class="ui-input ui-mono"
							name="baseUrl"
							type="url"
							defaultValue={instance?.baseUrl ?? ''}
							placeholder={t('connectors.form.baseUrlPlaceholder')}
							maxlength={2048}
							disabled={!editable}
							required
						/>
					</FormField>
					<FormField
						label={t('connectors.form.allowedHosts')}
						help={t('connectors.form.allowedHostsHelp')}
					>
						<input
							class="ui-input ui-mono"
							name="allowedHosts"
							defaultValue={(instance?.allowedHosts ?? []).join(', ')}
							placeholder={t('connectors.form.allowedHostsPlaceholder')}
							maxlength={2048}
							disabled={!editable}
						/>
					</FormField>
					<Select
						id="connectors-auth-kind"
						label={t('connectors.form.authKind')}
						help={t('connectors.form.authKindHelp')}
						value={activeKind}
						options={(definition?.authKinds ?? CONNECTOR_AUTH_KINDS).map(
							(kind) => ({
								value: kind,
								label: t('connectors.authKind.' + kind),
							}),
						)}
						required
						disabled={!editable || instance !== null}
						onChange={(value) => setAuthKind(value as ConnectorAuthKind)}
					/>
					@if (instance) {
						<div class="ui-form__row">
							<FormField
								label={t('connectors.form.credentialFingerprint')}
								help={t('connectors.form.credentialHelp')}
							>
								<span class="ui-mono">
									{instance.credentialFingerprint ??
										t('connectors.form.noCredential')}
								</span>
							</FormField>
							<FormField label={t('connectors.form.replaceCredentials')}>
								<Switch
									label={t('connectors.form.replaceCredentials')}
									checked={replaceCredentials}
									disabled={!editable}
									onChange={(value) => setReplaceCredentials(value)}
								/>
							</FormField>
						</div>
					}
					@if (replaceCredentials) {
						<>
							@for (const field of credentialFields(
								activeKind,
							); key field.key) {
								<FormField
									label={t('connectors.credential.' + field.key)}
									help={t('connectors.credential.' + field.key + 'Help')}
								>
									<input
										class="ui-input ui-mono"
										name={'credential-' + field.key}
										type={field.secret ? 'password' : 'text'}
										autocomplete="off"
										maxlength={4096}
										disabled={!editable}
									/>
								</FormField>
							}
						</>
					}
					@if (instance) {
						<>
							<FormField
								label={t('connectors.form.lastCall')}
								help={t('connectors.form.lastCallHelp')}
							>
								<span>{timestampLabel(instance.lastCallAt)}</span>
							</FormField>
							<Select
								id="connectors-test-operation"
								label={t('connectors.form.testOperation')}
								help={t('connectors.form.testOperationHelp')}
								value={selectedOperation}
								options={operations.map(
									(entry) => ({
										value: entry.key,
										label: entry.label,
									}),
								)}
								disabled={!editable}
								onChange={(value) => setOperation(value)}
							/>
							<FormField
								label={t('connectors.form.testPath')}
								help={t('connectors.form.testPathHelp')}
							>
								<input
									class="ui-input ui-mono"
									value={testPath}
									maxlength={1024}
									disabled={!editable}
									aria-label={t('connectors.form.testPath')}
									onInput={(event: Event) => setTestPath(
										(event.currentTarget as HTMLInputElement).value,
									)}
								/>
							</FormField>
						</>
					}
					@if (props.test) {
						<Alert
							tone={props.test.outcome === 'succeeded' ? 'info' : 'warning'}
						>{t('connectors.form.testResult', {
							outcome: props.test.outcome,
							status: props.test.status ?? 0,
							duration: props.test.durationMs,
							errorClass: props.test.errorClass ?? '',
						})}</Alert>
					}
					@if (props.test && props.test.bodyPreview !== '') {
						<FormField
							label={t('connectors.form.testBody')}
							help={t('connectors.form.testBodyHelp')}
						>
							<textarea
								class="ui-textarea ui-mono"
								readonly
								rows={6}
								aria-label={t('connectors.form.testBody')}
							>{props.test.bodyPreview}</textarea>
						</FormField>
					}
				</div>
			</div>
			<div class="ui-drawer__foot">
				<small>{t('connectors.form.constraint')}</small>
				<div class="ui-form__actions">
					<Button type="button" onClick={props.onCancel}>{t(
						'connectors.common.close',
					)}</Button>
					@if (instance && props.canManage) {
						<>
							<Button
								type="button"
								disabled={!editable}
								onClick={() => props.onTestCall(selectedOperation, testPath)}
							>{t('connectors.action.testCall')}</Button>
							@if (instance.status === 'active') {
								<Button
									type="button"
									disabled={!editable}
									onClick={props.onDisable}
								>{t('connectors.action.disable')}</Button>
							} @else {
								<>
									<Button
										type="button"
										disabled={!editable}
										onClick={props.onEnable}
									>{t('connectors.action.enable')}</Button>
									<Button
										type="button"
										variant="danger"
										disabled={!editable}
										onClick={props.onDelete}
									>{t('connectors.action.delete')}</Button>
								</>
							}
						</>
					}
					@if (props.canManage) {
						<Button type="submit" variant="primary" disabled={!editable}>
							{props.busy
								? t('connectors.common.saving')
								: instance
									? t('connectors.action.save')
									: t('connectors.action.create')}
						</Button>
					}
				</div>
			</div>
		</form>
	}
}
