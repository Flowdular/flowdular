import { Alert, Button, FormField, Tag } from '@coreloom/ui';
import type { SandboxState } from './api.ts';

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
				<h1>Connect the sandbox</h1>
				<p>
					The sandbox works against a running Coreloom application. Issue an API
					token there under Administration, API tokens, and paste it here. The
					token is encrypted on this machine and never sent to the browser
					again.
				</p>
			</div>
			<form class="ui-form" onSubmit={submit}>
				<FormField
					label="Application address"
					help="Local development server or a deployed instance."
					required
				>
					<input
						class="ui-input"
						name="platformUrl"
						defaultValue={props.state.configuration.platformUrl}
						placeholder="https://erp.example.com"
						required
					/>
				</FormField>
				<FormField
					label="API token"
					help="Needs sandbox.access.use, and sandbox.preview.data for live data."
					required
				>
					<input
						class="ui-input ui-mono"
						name="platformToken"
						type="password"
						placeholder="clat_…"
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
					<span class="ui-help">
						{'Workspace agents: ' + props.state.roles.length + ' roles'}
					</span>
					<div class="ui-form__actions">
						<Button variant="primary" type="submit" disabled={props.busy}>
							{props.busy ? 'Connecting…' : 'Connect'}
						</Button>
					</div>
				</div>
			</form>
		</section>
	</div>
}
