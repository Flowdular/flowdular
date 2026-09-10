import { Alert, Button, FormField } from '@flowdular/ui';
import { t } from '@flowdular/client';

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
				{t('profile.displayName.title')}
				<small>{t('profile.displayName.description')}</small>
			</span>
		</div>
		<form class="ui-form" onSubmit={submit}>
			<FormField
				label={t('profile.displayName.label')}
				help={t('profile.displayName.help')}
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
					{props.saving
						? t('profile.displayName.saving')
						: t('profile.displayName.save')}
				</Button>
			</div>
		</form>
	</section>
}
