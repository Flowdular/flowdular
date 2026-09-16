import {
	CellStack,
	CellTag,
	CellTime,
	Table,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import type { SandboxSessionRecord } from '../domain/types.ts';
import { sessionTone } from './presentation.ts';

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
			width: 'auto',
			cell: (session) =>
				<CellStack
					primary={session.title}
					secondary={origin(session)}
					secondaryMono
				/>,
		},
		{
			key: 'state',
			header: t('sandbox.sessions.state'),
			width: '160px',
			cell: (session) =>
				<CellTag
					tone={sessionTone(session.state)}
					dot
					label={t('sandbox.sessionState.' + session.state)}
				/>,
		},
		{
			key: 'updated',
			header: t('sandbox.sessions.updated'),
			width: '170px',
			numeric: true,
			priority: 2,
			cell: (session) => <CellTime value={session.updatedAt} />,
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
