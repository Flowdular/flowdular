import { Icon, Tag, type TagTone } from '@flowdular/ui';
import {
	checkHasEvidence,
	readFinding,
	REVIEW_CHECKS,
	type ReviewReading,
	type ReviewSeverity,
} from '../server/review-report.ts';
import { useTranslation } from './i18n.ts';

function severityTone(severity: ReviewSeverity): TagTone {
	if (severity === 'medium') return 'warning';
	if (severity === 'low') return 'neutral';
	return 'danger';
}

/* The verdict a review turn closes with: each required check, the findings,
   and the report as written one click away for the specialist. */
export function ReviewReportCard(props: { readonly review: ReviewReading }) @{
	const { t } = useTranslation();
	const report = props.review.report;
	const passed = report.verdict === 'pass';
	const findings = report.findings.map(readFinding);
	<section
		class={['chat__gate', passed ? 'chat__gate--passed' : 'chat__gate--failed']}
	>
		<header class="chat__meta">
			<Icon name={passed ? 'check' : 'alert'} size={14} />
			<span>{t('sandbox.review.title')}</span>
			<Tag tone={passed ? 'success' : 'danger'}>{t(
				'sandbox.review.verdict.' + report.verdict,
			)}</Tag>
		</header>
		<ul class="review-checks">
			@for (const check of REVIEW_CHECKS; key check) {
				<li>
					<span>{t('sandbox.review.check.' + check)}</span>
					@if (checkHasEvidence(report.checks[check])) {
						<Tag tone="success" dot>{t('sandbox.review.evidence.given')}</Tag>
					} @else {
						<Tag tone="warning" dot>{t('sandbox.review.evidence.missing')}</Tag>
					}
				</li>
			}
		</ul>
		@if (findings.length > 0) {
			<ul class="gate-issues">
				@for (const [index, finding] of findings.entries(); key index) {
					<li>
						@if (finding.severity) {
							<div class="review-finding__where">
								<Tag tone={severityTone(finding.severity!)}>{t(
									'sandbox.review.severity.' + finding.severity,
								)}</Tag>
								<span
									class="ui-mono gate-issues__where"
								>{finding.location}</span>
							</div>
						}
						<p class="gate-issues__message">{finding.text}</p>
					</li>
				}
			</ul>
		} @else {
			<div class="ui-help">{t('sandbox.review.noFindings')}</div>
		}
		<details>
			<summary>{t('sandbox.review.raw')}</summary>
			<pre class="ui-code">{props.review.raw}</pre>
		</details>
	</section>
}
