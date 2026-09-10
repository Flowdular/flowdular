import { Table, Tag, type TableColumn } from '@flowdular/ui';
import { t } from '@flowdular/client';
import type { SandboxSessionRecord } from '../domain/types.ts';
import { sessionTone, timestamp } from './presentation.ts';

export interface SandboxSessionListProps {
	readonly sessions: readonly SandboxSessionRecord[];
}

function origin(session: SandboxSessionRecord): string {
	return session.moduleId + ' · ' + session.driver + ' · ' + session.mode;
}

function columns(): readonly TableColumn<SandboxSessionRecord>[] {
	return [
		{
			key: 'session',
			header: t('sandbox.sessions.session'),
			width: '50%',
			cell: (session) => <span class="ui-cell">
				<b>{session.title}</b>
				<small class="ui-mono">{origin(session)}</small>
			</span>,
		},
		{
			key: 'state',
			header: t('sandbox.sessions.state'),
			width: '20%',
			cell: (session) =>
				<Tag tone={sessionTone(session.state)} dot>{t(
					'sandbox.sessionState.' + session.state,
				)}</Tag>,
		},
		{
			key: 'updated',
			header: t('sandbox.sessions.updated'),
			width: '30%',
			numeric: true,
			cell: (session) => timestamp(session.updatedAt),
		},
	];
}

export function SandboxSessionList(props: SandboxSessionListProps) @{
	<Table
		caption={t('sandbox.sessions.caption')}
		columns={columns()}
		rows={props.sessions}
		rowKey={(session) => session.id}
		empty={{
			icon: 'flask',
			title: t('sandbox.sessions.emptyTitle'),
			hint: t('sandbox.sessions.empty'),
		}}
	/>
}
