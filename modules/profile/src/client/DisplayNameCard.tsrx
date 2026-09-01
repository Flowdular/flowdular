import { Alert, Button, FormField } from '@coreloom/ui';

export interface DisplayNameCardProps {
	readonly displayName: string;
	readonly saving: boolean;
	readonly error: string;
	readonly success: string;
	readonly onDisplayNameChange: (value: string) => void;
	readonly onSubmit: (displayName: string) => Promise<void>;
}

export function DisplayNameCard(props: DisplayNameCardProps) @{
	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		await props.onSubmit(props.displayName);
	};

	<section class="ui-card">
		<div class="ui-card__head">
			<span class="ui-card__title">
				Display name
				<small>Shown to members of this workspace</small>
			</span>
		</div>
		<form class="ui-form" onSubmit={submit}>
			<FormField
				label="Display name"
				help="Use between 2 and 120 characters."
				required
			>
				<input
					class="ui-input"
					name="displayName"
					value={props.displayName}
					onInput={(event) => props.onDisplayNameChange(
						event.currentTarget.value,
					)}
					minlength={2}
					maxlength={120}
					autocomplete="name"
					required
				/>
			</FormField>
			@if (props.error) {
				<Alert>{props.error}</Alert>
			} @else if (props.success) {
				<Alert tone="info">{props.success}</Alert>
			}
			<div class="ui-form__actions">
				<Button variant="primary" type="submit" disabled={props.saving}>
					{props.saving ? 'Saving…' : 'Save display name'}
				</Button>
			</div>
		</form>
	</section>
}
