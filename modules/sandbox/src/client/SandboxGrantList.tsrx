import { Table, Tag, type TableColumn } from '@coreloom/ui';
import { t } from '@coreloom/client';
import type { SandboxAccessGrant } from '../domain/types.ts';
import {
	capabilityLabel,
	grantState,
	grantTone,
	timestamp,
} from './presentation.ts';

export interface SandboxGrantListProps {
	readonly grants: readonly SandboxAccessGrant[];
	readonly busy: boolean;
	readonly onRevoke: (accountId: string) => void;
}

function capabilities(grant: SandboxAccessGrant): string {
	return grant.capabilities.map(capabilityLabel).join(' · ');
}

function columns(now: number): readonly TableColumn<SandboxAccessGrant>[] {
	return [
		{
			key: 'account',
			header: t('sandbox.access.account'),
			width: '26%',
			cell: (grant) => <span class="ui-cell">
				<b>{grant.displayName}</b>
				<small class="ui-mono">{grant.email}</small>
			</span>,
		},
		{
			key: 'capabilities',
			header: t('sandbox.access.capabilities'),
			width: '36%',
			cell: (grant) =>
				<span class="ui-cell__muted">{capabilities(grant)}</span>,
		},
		{
			key: 'status',
			header: t('sandbox.access.status'),
			width: '28%',
			cell: (grant) => <span class="ui-table__state">
				<Tag tone={grantTone(grantState(grant, now))} dot>{t(
					'sandbox.grantState.' + grantState(grant, now),
				)}</Tag>
				<small>
					{grant.expiresAt === null
						? t('sandbox.access.noExpiry')
						: t('sandbox.access.until', { date: timestamp(grant.expiresAt) })}
				</small>
			</span>,
		},
	];
}

export function SandboxGrantList(props: SandboxGrantListProps) @{
	const now = Date.now();
	<Table
		caption={t('sandbox.access.caption')}
		columns={columns(now)}
		rows={props.grants}
		rowKey={(grant) => grant.id}
		empty={{
			icon: 'flask',
			title: t('sandbox.access.emptyTitle'),
			hint: t('sandbox.access.empty'),
		}}
		actionsLabel={t('sandbox.access.actions')}
		actions={(grant) => grant.revokedAt === null
			? [
					{
						id: 'revoke',
						label: t('sandbox.access.revoke'),
						icon: 'x',
						tone: 'danger',
						disabled: props.busy,
						onSelect: () => props.onRevoke(grant.accountId),
					},
				]
			: []}
	/>
}
