import { t } from '@flowdular/client';
import { Button, SettingRow, Tag } from '@flowdular/ui';
import type { MailStatus } from './api.ts';

export interface MailCardProps {
	readonly mail: MailStatus;
	readonly canManage: boolean;
	readonly busy: boolean;
	readonly result: { readonly ok: boolean; readonly message: string } | null;
	readonly onTest: () => void;
}

/* The relay of the whole installation. Its values are auth.core platform
   settings edited in Administration > Modules; this card states what is in
   effect and sends a message to the signed-in address to prove it. */
export function MailCard(props: MailCardProps) @{
	const source =
		props.mail.source === 'settings'
			? t('auth.settings.mail.sourceSettings')
			: t('auth.settings.mail.sourceEnvironment');

	<section class="ui-card">
		<div class="ui-card__head">
			<span class="ui-card__title">
				{t('auth.settings.mail.title')}
				<small>{t('auth.settings.mail.subtitle')}</small>
			</span>
		</div>
		<SettingRow
			label={t('auth.settings.mail.transport.label')}
			description={t('auth.settings.mail.transport.description', { source })}
			scopeLabel={t('auth.settings.mail.scope')}
		>
			<Tag>{props.mail.transport}</Tag>
			<Tag>{props.mail.from || t('auth.settings.mail.noSender')}</Tag>
		</SettingRow>
		<SettingRow
			label={t('auth.settings.mail.test.label')}
			description={t('auth.settings.mail.test.description')}
			status={props.result}
		>
			<Button
				size="sm"
				variant="primary"
				disabled={!props.canManage || props.busy || !props.mail.configured}
				onClick={() => props.onTest()}
			>{t('auth.settings.mail.test.action')}</Button>
		</SettingRow>
	</section>
}
