import { useState } from 'octane';
import { Alert, Button, FormField, Tag } from '@flowdular/ui';
import {
	AI_PROVIDER_CATALOG,
	AI_PROVIDER_KINDS,
} from '@flowdular/ai-provider/catalog';
import type { SandboxState } from './api.ts';
import { useTranslation } from './i18n.ts';

export interface ConnectViewProps {
	readonly state: SandboxState;
	readonly busy: boolean;
	readonly error: string;
	readonly onConnect: (input: {
		readonly platformUrl: string;
		readonly platformToken: string;
		readonly byokKind?: string;
		readonly byokModel?: string;
		readonly byokCredential?: string;
		readonly driver?: string;
		readonly driverModel?: string | null;
	}) => void;
}

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value.trim() : '';
}

export function ConnectView(props: ConnectViewProps) @{
	const { t } = useTranslation();
	const adopted = props.state.aiEnvironment;
	const [kind, setKind] = useState(adopted?.kind ?? 'anthropic');
	/* Only a self-hosted sandbox has no other way to reach a model. */
	const needsKey = props.state.configuration.mode === 'self-hosted' && !adopted;
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const credential = formValue(form, 'byokCredential');
		const model = formValue(form, 'byokModel');
		/* A typed key is a full setup. Without one, the provider and model are
   still saved when they differ from what the environment supplies, and
   that saved provider keeps reading the environment key. */
		const changed =
			adopted !== null && (kind !== adopted.kind || model !== adopted.model);
		props.onConnect({
			platformUrl: formValue(form, 'platformUrl'),
			platformToken: formValue(form, 'platformToken'),
			...(credential || changed
				? {
						byokKind: kind,
						byokModel: model,
						...(credential ? { byokCredential: credential } : {}),
						/* Self-hosted offers no local binary: this key is the driver. */
						...(props.state.configuration.mode === 'self-hosted'
							? { driver: 'byok', driverModel: null }
							: {}),
					}
				: {}),
		});
	};

	<div class="connect">
		<section class="connect__card">
			<div class="connect__head">
				<Tag tone="info" mono>{props.state.configuration.mode}</Tag>
				<h1>{t('sandbox.connect.title')}</h1>
				<p>{t('sandbox.connect.description')}</p>
			</div>
			<form class="ui-form" onSubmit={submit}>
				<FormField
					label={t('sandbox.connect.address.label')}
					help={t('sandbox.connect.address.help')}
					required
				>
					<input
						class="ui-input"
						name="platformUrl"
						defaultValue={props.state.configuration.platformUrl}
						placeholder={t('sandbox.connect.address.placeholder')}
						required
					/>
				</FormField>
				<FormField
					label={t('sandbox.connect.token.label')}
					help={t('sandbox.connect.token.help')}
					required
				>
					<input
						class="ui-input ui-mono"
						name="platformToken"
						type="password"
						placeholder={t('sandbox.connect.token.placeholder')}
						required
					/>
				</FormField>
				<div class="ui-form__section">
					<div class="ui-form__section-head">
						<b>{t('sandbox.connect.model.title')}</b>
						<small>
							{props.state.configuration.mode === 'self-hosted'
								? t('sandbox.connect.model.helpSelfHosted')
								: t('sandbox.connect.model.help')}
						</small>
					</div>
					@if (adopted) {
						<Alert tone="info">{t('sandbox.connect.model.adopted', {
							model: adopted.model,
							variable: adopted.variable,
						})}</Alert>
					}
					<FormField label={t('sandbox.connect.model.provider')}>
						<select
							class="ui-select"
							value={kind}
							onChange={(event) => setKind(
								event.currentTarget.value as typeof kind,
							)}
						>
							@for (const option of AI_PROVIDER_KINDS; key option) {
								<option
									value={option}
								>{AI_PROVIDER_CATALOG[option].label}</option>
							}
						</select>
					</FormField>
					<FormField label={t('sandbox.connect.model.model')}>
						<input
							class="ui-input"
							name="byokModel"
							maxLength={160}
							defaultValue={adopted?.model ??
								AI_PROVIDER_CATALOG[kind].defaultModel ??
								''}
						/>
					</FormField>
					<FormField
						label={t('sandbox.connect.model.key')}
						help={adopted
							? t('sandbox.connect.model.keyAdopted', {
									variable: adopted.variable,
								})
							: t('sandbox.connect.model.keyHelp')}
						required={needsKey}
					>
						<input
							class="ui-input ui-mono"
							name="byokCredential"
							type="password"
							autoComplete="new-password"
							maxLength={16384}
							required={needsKey}
						/>
					</FormField>
				</div>
				@if (props.state.connection.error && !props.error) {
					<Alert tone="warning">{props.state.connection.error.message}</Alert>
				}
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
				<div class="ui-form__foot">
					<span class="ui-help">{t('sandbox.connect.roles', {
						count: props.state.roles.length,
					})}</span>
					<div class="ui-form__actions">
						<Button variant="primary" type="submit" disabled={props.busy}>
							{props.busy
								? t('sandbox.connect.connecting')
								: t('sandbox.connect.action')}
						</Button>
					</div>
				</div>
			</form>
		</section>
	</div>
}
