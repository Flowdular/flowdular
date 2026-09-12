import { useMemo } from 'octane';
import { t } from '@flowdular/client';
import { Button, FormField, Switch } from '@flowdular/ui';
import { createStore, useValue } from 'segment-state';
import type { IdentityProviderSummary } from '../../domain/types.ts';
import type { IdentityProviderRequest } from './api.ts';

export interface IdentityProviderFormProps {
	/** Absent while creating; the record being edited otherwise. */
	readonly provider?: IdentityProviderSummary | undefined;
	readonly busy: boolean;
	readonly onCancel: () => void;
	readonly onSubmit: (input: IdentityProviderRequest) => void;
}

function list(value: string): readonly string[] {
	return value.split(',').map((entry) => entry.trim()).filter(
		(entry) => entry.length > 0,
	);
}

export function IdentityProviderForm(props: IdentityProviderFormProps) @{
	const provider = props.provider;
	const form = useMemo(
		() => createStore({
			jitEnabled: provider?.jitEnabled ?? false,
			allowedDomains: (provider?.allowedDomains ?? []).join(', '),
		}),
		[],
	);
	const [jitEnabled, setJitEnabled] = useValue(form.state.jitEnabled);
	const [allowedDomains, setAllowedDomains] = useValue(
		form.state.allowedDomains,
	);

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const data = new FormData(event.currentTarget as HTMLFormElement);
		const field = (name: string): string => {
			const entry = data.get(name);
			return typeof entry === 'string' ? entry.trim() : '';
		};
		const clientSecret = field('clientSecret');
		props.onSubmit({
			...(provider ? { id: provider.id } : { key: field('key') }),
			label: field('label'),
			issuer: field('issuer'),
			clientId: field('clientId'),
			...(clientSecret ? { clientSecret } : {}),
			scopes: list(field('scopes')),
			jitEnabled,
			allowedDomains: list(allowedDomains),
			jitRole: field('jitRole') || 'member',
		});
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				@if (!provider) {
					<FormField
						label={t('auth.providers.form.key')}
						help={t('auth.providers.form.keyHelp')}
						required
					>
						<input
							class="ui-input"
							name="key"
							minlength={2}
							maxlength={64}
							pattern="[a-z][a-z0-9-]*"
							autoFocus
							required
						/>
					</FormField>
				}
				<FormField label={t('auth.providers.form.label')} required>
					<input
						class="ui-input"
						name="label"
						maxlength={120}
						value={provider?.label ?? ''}
						required
					/>
				</FormField>
				<FormField
					label={t('auth.providers.form.issuer')}
					help={t('auth.providers.form.issuerHelp')}
					required
				>
					<input
						class="ui-input"
						name="issuer"
						type="url"
						maxlength={2048}
						value={provider?.issuer ?? ''}
						required
					/>
				</FormField>
				<FormField label={t('auth.providers.form.clientId')} required>
					<input
						class="ui-input"
						name="clientId"
						maxlength={256}
						value={provider?.clientId ?? ''}
						required
					/>
				</FormField>
				<FormField
					label={t('auth.providers.form.clientSecret')}
					help={provider
						? t('auth.providers.form.clientSecretKeep')
						: t('auth.providers.form.clientSecretOnce')}
					required={!provider}
				>
					<input
						class="ui-input"
						name="clientSecret"
						type="password"
						autocomplete="off"
						maxlength={1024}
						required={!provider}
					/>
				</FormField>
				<FormField
					label={t('auth.providers.form.scopes')}
					help={t('auth.providers.form.scopesHelp')}
				>
					<input
						class="ui-input"
						name="scopes"
						maxlength={512}
						value={(provider?.scopes ?? ['openid', 'email']).join(', ')}
					/>
				</FormField>
				<div class="ui-field">
					<span class="ui-label">{t('auth.providers.form.jit')}</span>
					<Switch
						checked={jitEnabled}
						label={t('auth.providers.form.jit')}
						onChange={setJitEnabled}
					/>
					<span class="ui-help">{t('auth.providers.form.jitHelp')}</span>
				</div>
				@if (jitEnabled) {
					<>
						<FormField
							label={t('auth.providers.form.allowedDomains')}
							help={t('auth.providers.form.allowedDomainsHelp')}
							required
						>
							<input
								class="ui-input"
								value={allowedDomains}
								maxlength={512}
								onInput={(event) => setAllowedDomains(
									event.currentTarget.value,
								)}
								required
							/>
						</FormField>
						<FormField
							label={t('auth.providers.form.jitRole')}
							help={t('auth.providers.form.jitRoleHelp')}
						>
							<input
								class="ui-input"
								name="jitRole"
								maxlength={64}
								value={provider?.jitRole || 'member'}
							/>
						</FormField>
					</>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>{t('auth.providers.form.secretNote')}</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>{t('auth.common.cancel')}</Button>
				<Button variant="primary" type="submit" disabled={props.busy}>
					{props.busy
						? t('auth.common.wait')
						: provider
							? t('auth.common.save')
							: t('auth.providers.form.create')}
				</Button>
			</div>
		</div>
	</form>
}
