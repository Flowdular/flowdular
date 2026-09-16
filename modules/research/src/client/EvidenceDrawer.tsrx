import { Alert, Drawer, Tag } from '@flowdular/ui';
import { t } from '@flowdular/client';
import type { ResearchEvidenceDetail } from '../domain/types.ts';
import { timestampLabel } from './presentation.ts';

export interface EvidenceDrawerProps {
	readonly open: boolean;
	readonly detail: ResearchEvidenceDetail | null;
	readonly status: 'idle' | 'loading' | 'error';
	readonly error: string;
	readonly onClose: () => void;
}

export function EvidenceDrawer(props: EvidenceDrawerProps) @{
	const detail = props.detail;

	<Drawer
		open={props.open}
		title={detail?.title || t('research.evidence.title')}
		subtitle={detail ? detail.url : ''}
		width="lg"
		onClose={props.onClose}
	>
		<div class="ui-drawer__body">
			@if (props.status === 'loading') {
				<p class="ui-help">{t('research.common.loading')}</p>
			} @else if (props.status === 'error') {
				<Alert>{props.error}</Alert>
			} @else if (detail) {
				<div class="ui-form">
					<dl class="research-facts">
						<dt>{t('research.evidence.url')}</dt>
						<dd>
							<a
								class="ui-mono"
								href={detail.url}
								target="_blank"
								rel="noopener noreferrer nofollow"
							>{detail.url}</a>
						</dd>
						<dt>{t('research.evidence.retrievedAt')}</dt>
						<dd>{timestampLabel(detail.retrievedAt)}</dd>
						<dt>{t('research.evidence.contentSha256')}</dt>
						<dd>
							<span class="ui-mono">{detail.contentSha256}</span>
						</dd>
						<dt>{t('research.evidence.runId')}</dt>
						<dd>
							<span class="ui-mono">
								{detail.runId ?? t('research.common.none')}
							</span>
						</dd>
						<dt>{t('research.evidence.documentId')}</dt>
						<dd>
							<span class="ui-mono">
								{detail.documentId ?? t('research.common.none')}
							</span>
						</dd>
						<dt>{t('research.evidence.fullText')}</dt>
						<dd>
							<Tag tone={detail.hasFullText ? 'success' : 'neutral'} dot>
								{detail.hasFullText
									? t('research.evidence.fullTextStored')
									: t('research.evidence.fullTextNotStored')}
							</Tag>
						</dd>
					</dl>
					<section class="research-excerpt">
						<h3 class="ui-label">{t('research.evidence.excerpt')}</h3>
						<pre class="research-excerpt__text">
							{detail.excerpt === ''
								? t('research.evidence.excerptEmpty')
								: detail.excerpt}
						</pre>
					</section>
					<section>
						<h3 class="ui-label">{t('research.evidence.links')}</h3>
						@if (detail.links.length === 0) {
							<p class="ui-help">{t('research.evidence.linksEmpty')}</p>
						} @else {
							<ul class="research-links">
								@for (const link of detail.links; key link.ownerModule + ':' +
									link.recordRef) {
									<li>
										<span class="ui-mono">{link.ownerModule}</span>
										<span class="ui-mono">{link.recordRef}</span>
									</li>
								}
							</ul>
						}
					</section>
				</div>
			}
		</div>
	</Drawer>
}
