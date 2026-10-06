import type { GateIssue } from '../server/gates.ts';
import { useTranslation } from './i18n.ts';

/* The errors a failed validator reported, each with its code, file and path,
   and how many more there were past the bound. */
export function GateIssues(props: {
	readonly issues: readonly GateIssue[];
	readonly more?: number | undefined;
}) @{
	const { t } = useTranslation();
	<ul class="gate-issues">
		@for (const [index, issue] of props.issues.entries(); key index) {
			<li>
				<p class="gate-issues__message">{issue.message}</p>
				<span class="ui-mono gate-issues__where">{[
					issue.code,
					issue.file,
					issue.path,
				].filter(Boolean).join(' · ')}</span>
			</li>
		}
		@if (props.more) {
			<li class="ui-help">{t('sandbox.gates.more', { count: props.more })}</li>
		}
	</ul>
}
