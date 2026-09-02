import { useState } from 'octane';
import { Button, Icon, Tag } from '@coreloom/ui';
import type { SandboxSession } from '../server/sessions.ts';
import type { WorkspaceModuleSummary } from './api.ts';
import { useTranslation } from './i18n.ts';

export interface SessionBarProps {
	readonly session: SandboxSession;
	readonly changes: number;
	readonly busy: boolean;
	/* The module the panes show; empty means every module of the session. */
	readonly activeModule: string;
	/* Every module of the workspace, so the session can take another one in. */
	readonly workspaceModules: readonly WorkspaceModuleSummary[];
	readonly onModule: (directory: string) => void;
	readonly onAddModule: (moduleId: string) => void;
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
	const { t } = useTranslation();
	const delivered = Boolean(props.session.ejectedAt);
	const modules = props.session.modules;
	const held = new Set(modules.map((module) => module.id));
	const candidates = props.workspaceModules.filter(
		(module) => !held.has(module.id),
	);
	const [adding, setAdding] = useState(false);
	const [chosen, setChosen] = useState('');

	<div class="session-bar">
		<button class="session-bar__back" type="button" onClick={props.onBack}>
			<Icon name="chevron-down" size={14} />
			{t('sandbox.session.back')}
		</button>
		<span class="session-bar__title">
			<b>{props.session.title}</b>
			<small class="ui-mono">
				{modules.length === 1
					? props.session.moduleId
					: t('sandbox.session.modules', { count: modules.length })}
			</small>
		</span>
		<Tag tone={stateTone(props.session.state)} dot>
			{delivered
				? t('sandbox.session.state.delivered')
				: t('sandbox.session.state.' + props.session.state)}
		</Tag>
		@if (modules.length > 1) {
			<select
				class="chat__picker"
				aria-label={t('sandbox.session.module.visible')}
				value={props.activeModule}
				onChange={(event) => props.onModule(event.currentTarget.value)}
			>
				<option value="">{t('sandbox.session.module.all')}</option>
				@for (const module of modules; key module.id) {
					<option value={module.directory}>{module.id}</option>
				}
			</select>
		}
		@if (adding) {
			<>
				<select
					class="chat__picker"
					aria-label={t('sandbox.session.module.addLabel')}
					value={chosen}
					onChange={(event) => setChosen(event.currentTarget.value)}
				>
					<option value="">{t('sandbox.session.module.choose')}</option>
					@for (const module of candidates; key module.id) {
						<option value={module.id}>{module.id}</option>
					}
				</select>
				<Button
					size="sm"
					variant="primary"
					disabled={props.busy || !chosen}
					onClick={() => {
						props.onAddModule(chosen);
						setChosen('');
						setAdding(false);
					}}
				>{t('sandbox.common.add')}</Button>
				<Button size="sm" variant="ghost" onClick={() => setAdding(false)}>{t(
					'sandbox.common.cancel',
				)}</Button>
			</>
		} @else if (!delivered && candidates.length > 0) {
			<button
				class="session-bar__add"
				type="button"
				disabled={props.busy}
				onClick={() => setAdding(true)}
			>
				<Icon name="plus" size={12} />
				{t('sandbox.session.module.add')}
			</button>
		}
		<span class="sandbox__spacer"></span>
		<Button
			size="sm"
			variant="ghost"
			onClick={props.onGates}
			disabled={props.busy}
		>
			<Icon name="check" size={14} />
			{t('sandbox.session.gates')}
		</Button>
		<Button
			size="sm"
			variant="ghost"
			onClick={props.onChanges}
			disabled={props.changes === 0}
		>
			<Icon name="code" size={14} />
			{t('sandbox.session.changes', { count: props.changes })}
		</Button>
		<Button
			size="sm"
			variant={delivered ? 'ghost' : 'secondary'}
			onClick={props.onEject}
			disabled={props.busy || props.changes === 0}
		>
			<Icon name={delivered ? 'check' : 'download'} size={14} />
			{delivered
				? t('sandbox.session.deliverAgain')
				: t('sandbox.session.eject')}
		</Button>
	</div>
}
