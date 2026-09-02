import { useState } from 'octane';
import { Button, Icon, Tag } from '@coreloom/ui';
import type {
	ModuleSpecReview,
	SpecChangeKind,
	SpecFieldChange,
} from '../server/spec.ts';
import { useTranslation } from './i18n.ts';

export interface SpecReviewCardProps {
	readonly review: ModuleSpecReview;
	readonly busy: boolean;
	readonly onApprove: () => void;
	readonly onRequestChanges: (comment: string) => void;
	readonly onEdit: () => void;
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
	id: 'id',
	specVersion: 'version',
	status: 'status',
	name: 'name',
	description: 'description',
	profile: 'profile',
	tenancy: 'tenancy',
	capabilities: 'capability',
	locales: 'locale',
	dependencies: 'dependency',
	invariants: 'invariant',
	dataOwnership: 'dataOwnership',
	permissions: 'permission',
	acceptanceScenarios: 'scenario',
};

const IDENTIFIER_FIELDS = new Set([
	'id',
	'specVersion',
	'status',
	'profile',
	'tenancy',
	'capabilities',
	'locales',
	'dependencies',
	'permissions',
	'acceptanceScenarios',
]);

function changeSign(kind: SpecChangeKind): string {
	if (kind === 'added') return '+';
	if (kind === 'removed') return '-';
	return '~';
}

function changeKey(change: SpecFieldChange): string {
	return `${change.field}:${change.kind}:${change.key ?? ''}`;
}

/* What the entry became, without repeating the identifier that names it. */
function changeValue(change: SpecFieldChange): string {
	if (change.kind === 'changed') {
		return `${change.before ?? ''} → ${change.after ?? ''}`;
	}
	const value = change.after ?? change.before ?? '';
	return value === change.key ? '' : value;
}

/* What the operator approves: the specification as it stands, and for a change
   the difference from the copy the session started with. */
export function SpecReviewCard(props: SpecReviewCardProps) @{
	const { t } = useTranslation();
	const review = props.review;
	const draft = review.draft;
	const changes = review.changes;
	const isEdit = review.kind === 'edit';
	const marks = new Map<string, SpecChangeKind>();
	for (const change of changes) {
		if (change.key) marks.set(change.field + ':' + change.key, change.kind);
	}
	const markOf = (field: string, key: string) => isEdit
		? marks.get(field + ':' + key) ?? null
		: null;
	const [asking, setAsking] = useState(false);
	const [comment, setComment] = useState('');

	<section class="spec-review">
		<header class="spec-review__head">
			<span class="ui-mono">{review.moduleId}</span>
			<Tag mono tone={review.approved ? 'success' : 'warning'}>
				{review.status ?? t('sandbox.spec.status.none')}
			</Tag>
			@if (draft && draft.specVersion) {
				<Tag mono>{'v' + draft.specVersion}</Tag>
			}
			<span class="sandbox__spacer"></span>
			<span class="spec-review__path ui-mono">{review.path}</span>
		</header>

		@if (!draft) {
			<p class="spec-review__empty">
				{review.present
					? t('sandbox.spec.unreadable')
					: t('sandbox.spec.missing')}
			</p>
		} @else {
			<>
				@if (isEdit) {
					<div class="spec-review__block">
						<h4 class="spec-review__title">
							{changes.length === 0
								? t('sandbox.spec.changes.empty')
								: t('sandbox.spec.changes.title')}
						</h4>
						@if (changes.length > 0) {
							<ul class="spec-review__changes">
								@for (const change of changes; key changeKey(change)) {
									<li
										class={'spec-review__change spec-review__change--' +
											change.kind}
									>
										<span class="spec-review__sign">{changeSign(
											change.kind,
										)}</span>
										<span class="spec-review__field">
											{FIELD_LABELS[change.field]
												? t('sandbox.spec.field.' + FIELD_LABELS[change.field])
												: change.field}
										</span>
										@if (change.key) {
											<span
												class={IDENTIFIER_FIELDS.has(change.field)
													? 'ui-mono'
													: ''}
											>{change.key}</span>
										}
										@if (changeValue(change)) {
											<span class="spec-review__value">{changeValue(
												change,
											)}</span>
										}
									</li>
								}
							</ul>
						}
					</div>
				}

				<div class="spec-review__block">
					<h4 class="spec-review__title">{draft.name || review.moduleId}</h4>
					<p class="spec-review__text">{draft.description}</p>
					<dl class="spec-review__facts">
						<dt>{t('sandbox.spec.facts.capabilities')}</dt>
						<dd class="ui-mono">
							{draft.capabilities.join(', ') || t('sandbox.common.none')}
						</dd>
						<dt>{t('sandbox.spec.facts.tenancy')}</dt>
						<dd class="ui-mono">
							{draft.tenancy || t('sandbox.common.unset')}
						</dd>
						<dt>{t('sandbox.spec.facts.profile')}</dt>
						<dd class="ui-mono">
							{draft.profile || t('sandbox.common.unset')}
						</dd>
					</dl>
				</div>

				@if (draft.permissions.length > 0) {
					<div class="spec-review__block">
						<h4 class="spec-review__title">{t('sandbox.spec.permissions')}</h4>
						<ul class="spec-review__list">
							@for (const permission of draft.permissions; key permission.id) {
								<li
									class={[
										'spec-review__item',
										markOf('permissions', permission.id) &&
											'spec-review__item--' +
												markOf('permissions', permission.id),
									]}
								>
									<span class="ui-mono">{permission.id}</span>
									<span>{permission.description}</span>
								</li>
							}
						</ul>
					</div>
				}

				@if (draft.invariants.length > 0) {
					<div class="spec-review__block">
						<h4 class="spec-review__title">{t('sandbox.spec.invariants')}</h4>
						<ul class="spec-review__list">
							@for (const invariant of draft.invariants; key invariant) {
								<li
									class={[
										'spec-review__item',
										markOf('invariants', invariant) &&
											'spec-review__item--' + markOf('invariants', invariant),
									]}
								>
									<span>{invariant}</span>
								</li>
							}
						</ul>
					</div>
				}

				@if (draft.dataOwnership.length > 0) {
					<div class="spec-review__block">
						<h4 class="spec-review__title">{t(
							'sandbox.spec.dataOwnership',
						)}</h4>
						<ul class="spec-review__list">
							@for (const sentence of draft.dataOwnership; key sentence) {
								<li
									class={[
										'spec-review__item',
										markOf('dataOwnership', sentence) &&
											'spec-review__item--' + markOf('dataOwnership', sentence),
									]}
								>
									<span>{sentence}</span>
								</li>
							}
						</ul>
					</div>
				}

				@if (draft.acceptanceScenarios.length > 0) {
					<div class="spec-review__block">
						<h4 class="spec-review__title">{t(
							'sandbox.spec.acceptanceScenarios',
						)}</h4>
						<ul class="spec-review__list">
							@for (const scenario of draft.acceptanceScenarios; key scenario.id) {
								<li
									class={[
										'spec-review__scenario',
										markOf('acceptanceScenarios', scenario.id) &&
											'spec-review__item--' +
												markOf('acceptanceScenarios', scenario.id),
									]}
								>
									<span class="ui-mono">{scenario.id}</span>
									<span>
										<b>{t('sandbox.spec.given')}</b>
										{' ' + scenario.given}
									</span>
									<span>
										<b>{t('sandbox.spec.when')}</b>
										{' ' + scenario.when}
									</span>
									<span>
										<b>{t('sandbox.spec.then')}</b>
										{' ' + scenario.then}
									</span>
								</li>
							}
						</ul>
					</div>
				}
			</>
		}

		@if (asking) {
			<div class="spec-review__ask">
				<textarea
					class="ui-textarea"
					rows={3}
					placeholder={t('sandbox.spec.request.placeholder')}
					value={comment}
					onInput={(event) => setComment(event.currentTarget.value)}
				></textarea>
				<div class="ui-form__actions">
					<Button
						size="sm"
						variant="primary"
						disabled={props.busy || comment.trim().length === 0}
						onClick={() => {
							props.onRequestChanges(comment.trim());
							setComment('');
							setAsking(false);
						}}
					>
						<Icon name="play" size={14} />
						{t('sandbox.spec.request.send')}
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setAsking(false)}>{t(
						'sandbox.common.cancel',
					)}</Button>
				</div>
			</div>
		} @else {
			<div class="ui-form__actions">
				<Button
					size="sm"
					variant="primary"
					disabled={props.busy}
					onClick={props.onApprove}
				>
					<Icon name="check" size={14} />
					{t('sandbox.spec.approve')}
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={props.busy}
					onClick={() => setAsking(true)}
				>
					<Icon name="help" size={14} />
					{t('sandbox.spec.request.action')}
				</Button>
				<Button size="sm" variant="ghost" onClick={props.onEdit}>
					<Icon name="code" size={14} />
					{t('sandbox.spec.edit')}
				</Button>
			</div>
		}
	</section>
}
