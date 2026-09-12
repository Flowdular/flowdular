import { Button, Drawer, Tag } from '@flowdular/ui';
import { t } from '@flowdular/client';
import type { ApprovalRequestView } from '../domain/types.ts';
import {
	decisionLabel,
	requirementLabel,
	statusLabel,
	statusTone,
	timestampLabel,
} from './presentation.ts';

export interface ApprovalRequestDrawerProps {
	readonly detail: ApprovalRequestView | null;
	readonly comment: string;
	readonly busy: boolean;
	readonly canDecide: boolean;
	readonly canCancel: boolean;
	readonly onComment: (value: string) => void;
	readonly onApprove: () => void;
	readonly onReject: () => void;
	readonly onCancel: () => void;
	readonly onClose: () => void;
}

export function ApprovalRequestDrawer(props: ApprovalRequestDrawerProps) @{
	const request = props.detail?.request ?? null;

	<Drawer
		open={props.detail !== null}
		title={request?.title ?? t('approvals.request.title')}
		subtitle={request ? request.subjectModule : ''}
		onClose={props.onClose}
	>
		@if (props.detail && request) {
			<div class="ui-drawer__body">
				<div class="ui-form">
					<p class="approvals-summary">
						{request.summary ?? t('approvals.request.noSummary')}
					</p>
					<dl class="approvals-facts">
						<dt>{t('approvals.column.status')}</dt>
						<dd>
							<Tag tone={statusTone(request.status)} dot>{statusLabel(
								request.status,
							)}</Tag>
						</dd>
						<dt>{t('approvals.column.subjectModule')}</dt>
						<dd>
							<span class="ui-mono">{request.subjectModule}</span>
						</dd>
						<dt>{t('approvals.request.subjectRef')}</dt>
						<dd>
							<span class="ui-mono">{request.subjectRef}</span>
						</dd>
						<dt>{t('approvals.request.permission')}</dt>
						<dd>
							<span class="ui-mono">{request.permission}</span>
						</dd>
						<dt>{t('approvals.column.action')}</dt>
						<dd>
							<span class="ui-mono">{request.action}</span>
						</dd>
						<dt>{t('approvals.request.requirement')}</dt>
						<dd>{requirementLabel(request.requirement)}</dd>
						<dt>{t('approvals.request.decisionsNeeded')}</dt>
						<dd class="num">{String(request.decisionsNeeded)}</dd>
						<dt>{t('approvals.column.requester')}</dt>
						<dd>
							<span class="ui-mono">{request.requesterAccountId}</span>
						</dd>
						<dt>{t('approvals.column.expiresAt')}</dt>
						<dd>{timestampLabel(request.expiresAt)}</dd>
						<dt>{t('approvals.request.resolvedAt')}</dt>
						<dd>{timestampLabel(request.resolvedAt)}</dd>
					</dl>
					<section class="approvals-ledger">
						<h3 class="ui-label">{t('approvals.request.ledger')}</h3>
						@if (props.detail.decisions.length === 0) {
							<p class="ui-help">{t('approvals.request.ledgerEmpty')}</p>
						} @else {
							<ul class="approvals-ledger__list">
								@for (const decision of props.detail.decisions; key decision.id) {
									<li>
										<b>{decisionLabel(decision.decision)}</b>
										<span class="ui-mono">
											{decision.deciderAccountId ??
												t('approvals.request.byTheLoop')}
										</span>
										<small>{timestampLabel(decision.decidedAt)}</small>
										@if (decision.comment) {
											<p
												class="approvals-ledger__comment"
											>{decision.comment}</p>
										}
									</li>
								}
							</ul>
						}
					</section>
					@if (props.canDecide) {
						<label class="ui-field">
							<span class="ui-label">{t('approvals.request.comment')}</span>
							<textarea
								class="ui-textarea"
								rows={3}
								maxlength={2000}
								value={props.comment}
								disabled={props.busy}
								onInput={(event: Event) => props.onComment(
									(event.target as HTMLTextAreaElement).value,
								)}
							/>
						</label>
					}
					<div class="ui-form__actions">
						@if (props.canDecide) {
							<>
								<Button
									variant="primary"
									disabled={props.busy}
									onClick={props.onApprove}
								>{t('approvals.action.approve')}</Button>
								<Button disabled={props.busy} onClick={props.onReject}>{t(
									'approvals.action.reject',
								)}</Button>
							</>
						}
						@if (props.canCancel) {
							<Button disabled={props.busy} onClick={props.onCancel}>{t(
								'approvals.action.cancel',
							)}</Button>
						}
					</div>
				</div>
			</div>
		}
	</Drawer>
}
