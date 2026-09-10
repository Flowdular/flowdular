import { useState } from 'octane';
import { Alert, Button, Drawer, FormField } from '@flowdular/ui';
import {
	AI_PROVIDER_CATALOG,
	AI_PROVIDER_KINDS,
} from '@flowdular/ai-provider/catalog';
import type { ConfigurationPatch } from './api.ts';
import type { SafeSandboxConfiguration } from '../server/config.ts';
import { useTranslation } from './i18n.ts';

export function ModelSettingsModal(props: {
	readonly configuration: SafeSandboxConfiguration;
	readonly busy: boolean;
	readonly error: string;
	readonly onSave: (input: ConfigurationPatch) => void;
	readonly onClose: () => void;
}) @{
	const { t } = useTranslation();
	const saved = props.configuration.byok;
	const [kind, setKind] = useState(saved?.kind ?? 'anthropic');
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		if (props.busy) return;
		const data = new FormData(event.currentTarget as HTMLFormElement);
		props.onSave({
			byokKind: kind,
			byokModel: String(data.get('model') ?? '').trim(),
			byokCredential: String(data.get('credential') ?? '').trim(),
			byokBaseUrl: String(data.get('baseURL') ?? '').trim(),
			byokResourceName: String(data.get('resourceName') ?? '').trim(),
			byokClearCredential: data.get('clear') === 'on',
			...(data.get('default') === 'on' ||
			props.configuration.mode === 'self-hosted'
				? { driver: 'byok', driverModel: null }
				: props.configuration.driver === 'byok' &&
				props.configuration.mode === 'loopback'
					? { driver: 'claude-code', driverModel: null }
					: {}),
		});
	};
	<Drawer
		open={true}
		title={t('sandbox.models.title')}
		subtitle={t('sandbox.models.description')}
		width="lg"
		onClose={() => {
			if (!props.busy) props.onClose();
		}}
	>
		<form class="ui-drawer__form" onSubmit={submit}>
			<div class="ui-drawer__body">
				<div class="ui-form">
					<Alert tone="info">{t('sandbox.models.help')}</Alert>
					<FormField label={t('sandbox.models.provider')}>
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
					<FormField label={t('sandbox.models.model')}>
						<input
							class="ui-input"
							name="model"
							required
							maxlength={160}
							defaultValue={saved?.model ?? ''}
						/>
					</FormField>
					<FormField
						label={t('sandbox.models.key')}
						help={saved?.credentialFingerprint
							? t('sandbox.models.keySaved')
							: t('sandbox.models.keyHelp')}
					>
						<input
							class="ui-input"
							name="credential"
							type="password"
							autocomplete="new-password"
							maxlength={16384}
						/>
					</FormField>
					<FormField label={t('sandbox.models.url')}>
						<input
							class="ui-input"
							name="baseURL"
							type="url"
							required={kind === 'openai-compatible'}
							maxlength={2048}
							defaultValue={saved?.baseURL ?? ''}
						/>
					</FormField>
					@if (kind === 'azure') {
						<FormField label={t('sandbox.models.resource')}>
							<input
								class="ui-input"
								name="resourceName"
								required
								maxlength={160}
								defaultValue={saved?.resourceName ?? ''}
							/>
						</FormField>
					}
					<label class="ui-checkbox">
						<input
							type="checkbox"
							name="default"
							disabled={props.configuration.mode === 'self-hosted'}
							defaultChecked={props.configuration.driver === 'byok' ||
								props.configuration.mode === 'self-hosted'}
						/>
						<span>{t('sandbox.models.default')}</span>
					</label>
					@if (saved?.credentialFingerprint) {
						<label class="ui-checkbox">
							<input type="checkbox" name="clear" />
							<span>{t('sandbox.models.clear')}</span>
						</label>
					}
					@if (props.error) {
						<Alert tone="danger">{props.error}</Alert>
					}
				</div>
			</div>
			<div class="ui-drawer__foot">
				<Button disabled={props.busy} onClick={props.onClose}>{t(
					'sandbox.models.cancel',
				)}</Button>
				@if (saved) {
					<Button
						variant="danger"
						disabled={props.busy}
						onClick={() => props.onSave({
							byokRemove: true,
							...(props.configuration.driver === 'byok'
								? {
										driver: props.configuration.mode === 'loopback'
											? 'claude-code'
											: 'byok',
										driverModel: null,
									}
								: {}),
						})}
					>{t('sandbox.models.remove')}</Button>
				}
				<Button type="submit" variant="primary" disabled={props.busy}>{t(
					'sandbox.models.save',
				)}</Button>
			</div>
		</form>
	</Drawer>
}
