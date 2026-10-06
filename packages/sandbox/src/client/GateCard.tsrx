import { Icon, Tag } from '@flowdular/ui';
import type { GateSummary } from '../server/gates.ts';
import { GateIssues } from './GateIssues.tsrx';
import { gateLabel } from './session-labels.ts';
import { useTranslation } from './i18n.ts';

/* A gate result in the transcript: which check ran and, when a validator
   failed, the errors of the reports that failed. The command and the full
   output stay one click away for the specialist. */
export function GateCard(props: {
	readonly gate: GateSummary;
	readonly output: string;
	/* Set when the session has several modules, so the card names its own. */
	readonly module: string | null;
}) @{
	const { t } = useTranslation();
	const issues = props.gate.issues ?? [];
	const failed = props.gate.status === 'failed';
	<article class={['chat__gate', 'chat__gate--' + props.gate.status]}>
		<header class="chat__meta">
			<Icon
				name={failed
					? 'alert'
					: props.gate.status === 'passed'
						? 'check'
						: 'info'}
				size={14}
			/>
			<span>{gateLabel(props.gate.id)}</span>
			<Tag
				tone={failed
					? 'danger'
					: props.gate.status === 'passed'
						? 'success'
						: 'warning'}
			>{t('sandbox.gates.status.' + props.gate.status)}</Tag>
			@if (props.module) {
				<span class="ui-mono chat__module">{props.module}</span>
			}
		</header>
		@if (issues.length > 0) {
			<GateIssues issues={issues} more={props.gate.moreIssues} />
		}
		@if (failed && props.output) {
			<details open={issues.length === 0}>
				<summary>{t('sandbox.gates.details')}</summary>
				<pre class="ui-code">{props.output}</pre>
			</details>
		}
	</article>
}
