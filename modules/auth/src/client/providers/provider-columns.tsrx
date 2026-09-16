import { t } from '@flowdular/client';
import {
	CellCode,
	CellMuted,
	CellStack,
	CellTag,
	type TableColumn,
} from '@flowdular/ui';
import type { IdentityProviderSummary } from '../../domain/types.ts';

export function identityProviderColumns(): readonly TableColumn<
	IdentityProviderSummary
>[] {
	return [
		{
			key: 'provider',
			header: t('auth.providers.column.provider'),
			width: 'auto',
			value: (provider) => provider.label,
			cell: (provider) =>
				<CellStack
					primary={provider.label}
					secondary={provider.key}
					secondaryMono
				/>,
		},
		{
			key: 'issuer',
			header: t('auth.providers.column.issuer'),
			width: '240px',
			priority: 2,
			value: (provider) => provider.issuer,
			cell: (provider) =>
				<CellStack
					primary={provider.issuer}
					primaryMono
					secondary={provider.scope === 'platform'
						? t('auth.providers.scope.platform')
						: t('auth.providers.scope.tenant')}
				/>,
		},
		{
			key: 'status',
			header: t('auth.providers.column.status'),
			width: '160px',
			value: (provider) => provider.status,
			cell: (provider) =>
				<CellStack
					primary={<CellTag
						tone={provider.status === 'active' ? 'success' : 'neutral'}
						dot
						label={t('auth.providers.status.' + provider.status)}
					/>}
					secondary={provider.jitEnabled
						? t('auth.providers.jit.on')
						: t('auth.providers.jit.off')}
				/>,
		},
		{
			key: 'fingerprint',
			header: t('auth.providers.column.fingerprint'),
			width: '180px',
			priority: 3,
			value: (provider) => provider.secretFingerprint,
			cell: (provider) => provider.secretFingerprint
				? <CellCode value={provider.secretFingerprint} />
				: <CellMuted>{t('auth.common.none')}</CellMuted>,
		},
	];
}
