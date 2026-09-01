import { Alert, Button, FormField } from '@coreloom/ui';
import { SANDBOX_GRANT_CAPABILITIES } from '../acl/permissions.ts';
import type { SandboxAccessCandidate } from '../domain/types.ts';
import type { GrantSandboxAccessRequest } from './api.ts';
import { capabilityLabel } from './presentation.ts';

export interface SandboxGrantFormProps {
	readonly candidates: readonly SandboxAccessCandidate[];
	readonly selectedAccountId: string;
	readonly busy: boolean;
	readonly error: string;
	readonly onSelect: (accountId: string) => void;
	readonly onCancel: () => void;
	readonly onSubmit: (input: GrantSandboxAccessRequest) => void;
}

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

function expiryTimestamp(days: string): number | null {
	const value = Number(days);
	if (!Number.isFinite(value) || value <= 0) return null;
	return Date.now() + Math.min(value, 365) * 24 * 60 * 60 * 1000;
}

export function SandboxGrantForm(props: SandboxGrantFormProps) @{
	const selected = props.candidates.find(
		(candidate) => candidate.accountId === props.selectedAccountId,
	);
	const available = selected?.availableCapabilities ?? [];

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const element = event.currentTarget as HTMLFormElement;
		const form = new FormData(element);
		props.onSubmit({
			accountId: formValue(form, 'accountId'),
			capabilities: form.getAll('capabilities').filter(
				(value) => typeof value === 'string',
			) as readonly string[],
			expiresAt: expiryTimestamp(formValue(form, 'expiryDays')),
			note: formValue(form, 'note') || null,
		});
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<FormField
					label="Workspace member"
					help="Only members that already hold sandbox scopes can be granted access."
					required
				>
					<select
						class="ui-select"
						name="accountId"
						value={props.selectedAccountId}
						onChange={(event) => props.onSelect(event.currentTarget.value)}
						required
					>
						<option value="">Select a member</option>
						@for (const candidate of props.candidates; key candidate.accountId) {
							<option
								value={candidate.accountId}
								disabled={candidate.availableCapabilities.length === 0}
							>
								{candidate.displayName + ' · ' + candidate.email}
							</option>
						}
					</select>
				</FormField>
				<div class="ui-field">
					<span class="ui-label">Capabilities</span>
					@if (available.length === 0) {
						<span class="ui-help">
							This member holds no sandbox scope. Change the membership role or
							grant the scope first.
						</span>
					} @else {
						<div class="ui-choices">
							@for (const capability of SANDBOX_GRANT_CAPABILITIES; key capability) {
								<label class="ui-checkbox">
									<input
										type="checkbox"
										name="capabilities"
										value={capability}
										defaultChecked={capability === 'sandbox.access.use'}
										disabled={!available.includes(capability)}
									/>
									<span>{capabilityLabel(capability)}</span>
								</label>
							}
						</div>
					}
					<span class="ui-help">sandbox.access.use is always required.</span>
				</div>
				<div class="ui-form__row">
					<FormField label="Expires in days" help="Leave empty for no expiry.">
						<input
							class="ui-input"
							name="expiryDays"
							type="number"
							min="1"
							max="365"
							step="1"
						/>
					</FormField>
					<FormField label="Note">
						<input class="ui-input" name="note" maxlength={280} />
					</FormField>
				</div>
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>Access is auditable and can be revoked at any time.</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>Cancel</Button>
				<Button
					variant="primary"
					type="submit"
					disabled={props.busy || available.length === 0}
				>
					{props.busy ? 'Saving…' : 'Grant access'}
				</Button>
			</div>
		</div>
	</form>
}
