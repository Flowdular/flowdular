import { useEffect, useMemo } from 'octane';
import { Icon } from '@flowdular/ui';
import { t } from '@flowdular/client';
import { useValue } from 'segment-state';
import { loadAssistantReadiness } from './api.ts';
import { AssistantPanel } from './AssistantPanel.tsrx';
import {
	createAssistantState,
	launcherState,
	pendingTurn,
} from './assistant-state.ts';

export interface AssistantLauncherProps {
	readonly csrfToken: string;
}

/* Readiness changes elsewhere: a provider is connected on another screen, the
   binding is set, the workspace flag is switched off. The topbar stays mounted
   across views, so the entry re-reads it on the signals it can observe. */
const READINESS_INTERVAL_MS = 120_000;

export function AssistantLauncher(props: AssistantLauncherProps) @{
	const assistant = useMemo(() => createAssistantState(), []);
	const [open, setOpen] = useValue(assistant.state.open);
	const [readiness, setReadiness] = useValue(assistant.state.readiness);
	const [conversation] = useValue(assistant.state.conversation);
	const mark = launcherState(readiness, pendingTurn(conversation));

	useEffect(() => {
		const refresh = () => loadAssistantReadiness().then(setReadiness).catch(
			() => setReadiness(null),
		);
		void refresh();
		const onVisibility = () => {
			if (document.visibilityState === 'visible') void refresh();
		};
		document.addEventListener('visibilitychange', onVisibility);
		const timer = setInterval(() => void refresh(), READINESS_INTERVAL_MS);
		return () => {
			document.removeEventListener('visibilitychange', onVisibility);
			clearInterval(timer);
		};
	}, []);

	/* A workspace that switched the assistant off, or a member without the
   permission, gets no entry at all rather than a padlock they cannot clear. */
	@if (readiness !== null && readiness.enabled && readiness.permitted) {
		<>
			<button
				class="assistant-launcher"
				type="button"
				data-state={mark}
				aria-label={mark === 'locked'
					? t('agents.assistant.launcher.locked')
					: t('agents.assistant.launcher.open')}
				title={mark === 'locked'
					? t('agents.assistant.launcher.locked')
					: t('agents.assistant.launcher.open')}
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				<span class="assistant-launcher__orbit" aria-hidden="true"></span>
				<Icon name="sparkle" size={17} />
				@if (mark === 'locked') {
					<span class="assistant-launcher__lock" aria-hidden="true">
						<Icon name="lock" size={8} strokeWidth={2.5} />
					</span>
				}
			</button>
			@if (open) {
				<AssistantPanel
					csrfToken={props.csrfToken}
					readiness={readiness}
					state={assistant}
					onClose={() => setOpen(false)}
				/>
			}
		</>
	}
}
