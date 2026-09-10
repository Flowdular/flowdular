import { activeLocale, t } from '@flowdular/client';
import { Tag, type TableColumn } from '@flowdular/ui';
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
			width: '38%',
			cell: (token) => <span class="ui-cell">
				<b>{token.label}</b>
				<small class="ui-mono">{identity(token)}</small>
			</span>,
		},
		{
			key: 'status',
			header: t('auth.tokens.column.status'),
			width: '30%',
			cell: (token) => <span class="ui-table__state">
				<Tag tone={tone(tokenState(token, now))} dot>{t(
					'auth.tokens.status.' + tokenState(token, now),
				)}</Tag>
				<small>
					{token.expiresAt === null
						? t('auth.tokens.form.noExpiry')
						: t('auth.tokens.until', { date: stamp(token.expiresAt) })}
				</small>
			</span>,
		},
		{
			key: 'lastUsed',
			header: t('auth.tokens.column.lastUsed'),
			width: '22%',
			numeric: true,
			cell: (token) => stamp(token.lastUsedAt),
		},
	];
}
