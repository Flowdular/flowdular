import { Button, Icon, Tag } from '@coreloom/ui';
import type { SandboxSession } from '../server/sessions.ts';

export interface SessionBarProps {
	readonly session: SandboxSession;
	readonly changes: number;
	readonly busy: boolean;
	readonly onBack: () => void;
	readonly onGates: () => void;
	readonly onChanges: () => void;
	readonly onEject: () => void;
}

function stateTone(
	state: SandboxSession['state'],
): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
	if (state === 'accepted') return 'success';
	if (state === 'failed' || state === 'blocked') return 'danger';
	if (state === 'awaiting-approval' || state === 'validating') return 'warning';
	if (state === 'draft') return 'neutral';
	return 'info';
}

/* Everything here belongs to one module session. The application bar above
   stays global, so a session action can never look like a workspace action. */
export function SessionBar(props: SessionBarProps) @{
	const delivered = Boolean(props.session.ejectedAt);

	<div class="session-bar">
		<button class="session-bar__back" type="button" onClick={props.onBack}>
			<Icon name="chevron-down" size={14} />
			Sessions
		</button>
		<span class="session-bar__title">
			<b>{props.session.title}</b>
			<small class="ui-mono">{props.session.moduleId}</small>
		</span>
		<Tag tone={stateTone(props.session.state)} dot>
			{delivered ? 'delivered' : props.session.state}
		</Tag>
		<span class="sandbox__spacer"></span>
		<Button
			size="sm"
			variant="ghost"
			onClick={props.onGates}
			disabled={props.busy}
		>
			<Icon name="check" size={14} />
			Run gates
		</Button>
		<Button
			size="sm"
			variant="ghost"
			onClick={props.onChanges}
			disabled={props.changes === 0}
		>
			<Icon name="code" size={14} />
			{'Changes (' + props.changes + ')'}
		</Button>
		<Button
			size="sm"
			variant={delivered ? 'ghost' : 'secondary'}
			onClick={props.onEject}
			disabled={props.busy || props.changes === 0}
		>
			<Icon name={delivered ? 'check' : 'download'} size={14} />
			{delivered ? 'Deliver again' : 'Eject'}
		</Button>
	</div>
}
