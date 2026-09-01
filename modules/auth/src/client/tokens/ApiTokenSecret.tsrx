import { Button, Icon } from '@coreloom/ui';

export interface ApiTokenSecretProps {
	readonly label: string;
	readonly token: string;
	readonly onDone: () => void;
}

export function ApiTokenSecret(props: ApiTokenSecretProps) @{
	<div class="ui-drawer__form">
		<div class="ui-drawer__body">
			<div class="token-secret">
				<span class="token-secret__icon">
					<Icon name="key" size={18} />
				</span>
				<b>{props.label + ' is ready'}</b>
				<p>
					Copy the value now. It is stored only as a hash and cannot be shown
					again.
				</p>
				<code>{props.token}</code>
				<Button
					variant="primary"
					onClick={() => void navigator.clipboard?.writeText(props.token).catch(
						() => undefined,
					)}
				>
					Copy token
				</Button>
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>Store it in the client that will present it.</small>
			<div class="ui-form__actions">
				<Button onClick={props.onDone}>Done</Button>
			</div>
		</div>
	</div>
}
