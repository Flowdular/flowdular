import { Alert, Button, FormField, Tag } from '@flowdular/ui';
import type { SandboxState } from './api.ts';
import { useTranslation } from './i18n.ts';

export interface ConnectViewProps {
	readonly state: SandboxState;
	readonly busy: boolean;
	readonly error: string;
	readonly onConnect: (input: {
		readonly platformUrl: string;
		readonly platformToken: string;
	}) => void;
}

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value.trim() : '';
}

export function ConnectView(props: ConnectViewProps) @{
	const { t } = useTranslation();
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		props.onConnect({
			platformUrl: formValue(form, 'platformUrl'),
			platformToken: formValue(form, 'platformToken'),
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
