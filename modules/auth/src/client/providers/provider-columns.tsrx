import { t } from '@flowdular/client';
import { Tag, type TableColumn } from '@flowdular/ui';
import type { IdentityProviderSummary } from '../../domain/types.ts';

export function identityProviderColumns(): readonly TableColumn<
	IdentityProviderSummary
>[] {
	return [
		{
			key: 'provider',
			header: t('auth.providers.column.provider'),
			width: '34%',
			value: (provider) => provider.label,
			cell: (provider) => <span class="ui-cell">
				<b>{provider.label}</b>
				<small class="ui-mono">{provider.key}</small>
			</span>,
		},
		{
			key: 'issuer',
			header: t('auth.providers.column.issuer'),
			width: '30%',
			value: (provider) => provider.issuer,
			cell: (provider) => <span class="ui-cell">
				<small class="ui-mono">{provider.issuer}</small>
				<small>
					{provider.scope === 'platform'
						? t('auth.providers.scope.platform')
						: t('auth.providers.scope.tenant')}
				</small>
			</span>,
		},
		{
			key: 'status',
			header: t('auth.providers.column.status'),
			width: '20%',
			value: (provider) => provider.status,
			cell: (provider) => <span class="ui-table__state">
				<Tag tone={provider.status === 'active' ? 'success' : 'neutral'} dot>{t(
					'auth.providers.status.' + provider.status,
				)}</Tag>
				<small>
					{provider.jitEnabled
						? t('auth.providers.jit.on')
						: t('auth.providers.jit.off')}
				</small>
			</span>,
		},
		{
			key: 'fingerprint',
			header: t('auth.providers.column.fingerprint'),
			width: '16%',
			value: (provider) => provider.secretFingerprint,
			cell: (provider) =>
				<small class="ui-mono">
					{provider.secretFingerprint || t('auth.common.none')}
				</small>,
		},
	];
}
