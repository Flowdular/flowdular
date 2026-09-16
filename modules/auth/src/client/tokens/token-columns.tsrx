import { activeLocale, t } from '@flowdular/client';
import {
	CellMuted,
	CellStack,
	CellTag,
	CellTime,
	type TableColumn,
} from '@flowdular/ui';
import type { ApiTokenRecord } from '../../domain/types.ts';
import { tokenState } from './state.ts';

function tone(state: string): 'success' | 'warning' | 'neutral' {
	if (state === 'active') return 'success';
	return state === 'expired' ? 'warning' : 'neutral';
}

function stamp(value: number | null): string {
	return value === null
		? t('auth.common.never')
		: new Intl.DateTimeFormat(activeLocale(), {
				dateStyle: 'medium',
				timeStyle: 'short',
			}).format(value);
}

function identity(token: ApiTokenRecord): string {
	const count = token.scopes.length;
	return token.prefix + '… · ' +
		t(count === 1 ? 'auth.tokens.scope.one' : 'auth.tokens.scope.other', {
			count: new Intl.NumberFormat(activeLocale()).format(count),
		});
}

export function apiTokenColumns(
	now: number,
): readonly TableColumn<ApiTokenRecord>[] {
	return [
		{
			key: 'token',
			header: t('auth.tokens.column.token'),
			width: 'auto',
			cell: (token) =>
				<CellStack
					primary={token.label}
					secondary={identity(token)}
					secondaryMono
				/>,
		},
		{
			key: 'status',
			header: t('auth.tokens.column.status'),
			width: '240px',
			cell: (token) =>
				<CellStack
					primary={<CellTag
						tone={tone(tokenState(token, now))}
						dot
						label={t('auth.tokens.status.' + tokenState(token, now))}
					/>}
					secondary={token.expiresAt === null
						? t('auth.tokens.form.noExpiry')
						: t('auth.tokens.until', { date: stamp(token.expiresAt) })}
				/>,
		},
		{
			key: 'lastUsed',
			header: t('auth.tokens.column.lastUsed'),
			width: '170px',
			numeric: true,
			priority: 2,
			cell: (token) => token.lastUsedAt === null
				? <CellMuted>{t('auth.common.never')}</CellMuted>
				: <CellTime value={token.lastUsedAt} />,
		},
	];
}
