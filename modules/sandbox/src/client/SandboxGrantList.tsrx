import {
	CellStack,
	CellTag,
	CellText,
	Table,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
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
			width: 'auto',
			cell: (grant) =>
				<CellStack
					primary={grant.displayName}
					secondary={grant.email}
					secondaryMono
				/>,
		},
		{
			key: 'capabilities',
			header: t('sandbox.access.capabilities'),
			width: 'auto',
			priority: 3,
			cell: (grant) => <CellText value={capabilities(grant)} wrap />,
		},
		{
			key: 'status',
			header: t('sandbox.access.status'),
			width: '200px',
			cell: (grant) =>
				<CellStack
					primary={<CellTag
						tone={grantTone(grantState(grant, now))}
						dot
						label={t('sandbox.grantState.' + grantState(grant, now))}
					/>}
					secondary={grant.expiresAt === null
						? t('sandbox.access.noExpiry')
						: t('sandbox.access.until', { date: timestamp(grant.expiresAt) })}
				/>,
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
