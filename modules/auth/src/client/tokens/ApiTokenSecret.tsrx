import { t } from '@flowdular/client';
import { Button, Icon } from '@flowdular/ui';

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
				<b>{t('auth.tokens.secret.ready', { label: props.label })}</b>
				<p>{t('auth.tokens.secret.copyNow')}</p>
				<code>{props.token}</code>
				<Button
					variant="primary"
					onClick={() => void navigator.clipboard?.writeText(props.token).catch(
						() => undefined,
					)}
				>{t('auth.tokens.secret.copy')}</Button>
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>{t('auth.tokens.secret.store')}</small>
			<div class="ui-form__actions">
				<Button onClick={props.onDone}>{t('auth.common.done')}</Button>
			</div>
		</div>
	</div>
}
