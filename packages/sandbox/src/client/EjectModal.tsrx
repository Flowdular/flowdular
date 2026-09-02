import { Alert, Button, Icon, Tag } from '@coreloom/ui';
import type {
	EjectPlanView,
	EjectStep,
	EjectSummary,
	EjectTargetId,
} from './api.ts';
import { activeLocale, t, useTranslation } from './i18n.ts';

export interface EjectModalProps {
	readonly plan: EjectPlanView;
	readonly steps: readonly EjectStep[];
	readonly summary: EjectSummary | null;
	readonly error: string;
	readonly running: boolean;
	readonly build: boolean;
	readonly onBuild: (build: boolean) => void;
	readonly onTarget: (target: EjectTargetId) => void;
	readonly onConfirm: () => void;
	readonly onClose: () => void;
}

const TARGET_LABELS: Readonly<Record<EjectTargetId, string>> = {
	workspace: 'target.workspace',
	'git-pr': 'target.gitPr',
};

function stepIcon(status: EjectStep['status']): string {
	if (status === 'passed') return 'check';
	if (status === 'failed') return 'alert';
	if (status === 'note') return 'help';
	return 'refresh';
}

function others(plan: EjectPlanView): string {
	const count = plan.modules.length - 1;
	return count > 0 ? t('sandbox.eject.moreModules', { count }) : '';
}

function lead(plan: EjectPlanView): string {
	if (plan.git) {
		return t('sandbox.eject.lead.git', {
			count: plan.git.changedFiles,
			branch: plan.git.branch,
			base: `${plan.git.remote}/${plan.git.baseBranch}`,
			target: plan.git.pushTarget,
			others: others(plan),
		});
	}
	if (plan.modules.length > 1) {
		return t('sandbox.eject.lead.multi', {
			files: plan.changedFiles,
			modules: plan.modules.length,
		});
	}
	const parts = [
		t('sandbox.eject.detail.filesLand', {
			count: plan.files.length,
			path: plan.targetPath,
		}),
		...(plan.overwrites.length > 0
			? [
					t('sandbox.eject.detail.overwritten', {
						count: plan.overwrites.length,
					}),
				]
			: []),
		...(plan.removes.length > 0
			? [t('sandbox.eject.detail.removed', { count: plan.removes.length })]
			: []),
	];
	return `${parts.join(', ')}${others(plan)}.`;
}

/* What one module of the delivery changes, in the same words the single-module
   lead uses. */
function moduleDetail(module: EjectPlanView['modules'][number]): string {
	return [
		t('sandbox.eject.detail.files', { count: module.files.length }),
		...(module.overwrites.length > 0
			? [
					t('sandbox.eject.detail.overwritten', {
						count: module.overwrites.length,
					}),
				]
			: []),
		...(module.removes.length > 0
			? [t('sandbox.eject.detail.removed', { count: module.removes.length })]
			: []),
		...(module.newPackages.length > 0
			? [
					t('sandbox.eject.detail.packages', {
						packages: module.newPackages.join(', '),
					}),
				]
			: []),
		...(module.enable ? [t('sandbox.eject.detail.enable')] : []),
	].join(', ');
}

function explanation(plan: EjectPlanView): string {
	if (plan.git) {
		return t('sandbox.eject.explanation.git');
	}
	return plan.modules.some((module) => module.enable)
		? t('sandbox.eject.explanation.enable', { count: plan.modules.length })
		: t('sandbox.eject.explanation.copy', { count: plan.modules.length });
}

function totalRemoves(plan: EjectPlanView): number {
	return plan.modules.reduce(
		(total, module) => total + module.removes.length,
		0,
	);
}

function newPackagesOf(plan: EjectPlanView): readonly string[] {
	return [
		...new Set(plan.modules.flatMap((module) => module.newPackages)),
	].sort();
}

/* What landed, named: one module by its id, several by their ids. */
function delivered(summary: EjectSummary): string {
	return `${summary.modules.join(', ')} ${t(
		'sandbox.eject.deliveredVerb.' +
			(summary.modules.length === 1 ? 'one' : 'other'),
	)}`;
}

function deliveredAt(at: number): string {
	return new Date(at).toLocaleString(activeLocale());
}

/* Eject is a delivery, so it gets its own screen: what will land, every step
   while it lands, and a plain confirmation when it has. */
export function EjectModal(props: EjectModalProps) @{
	const { t } = useTranslation();
	const phase =
		props.summary
			? 'done'
			: props.error
				? 'failed'
				: props.running
					? 'running'
					: 'plan';
	const git = props.plan.git;
	const unavailable = props.plan.availableTargets.filter(
		(target) => !target.available,
	);
	const blocked = git ? !git.guardrails.ok : false;

	<div class="workbench eject" role="dialog" aria-modal="true">
		<div class="eject__panel">
			<header class="eject__head">
				<span class="eject__title">
					@if (phase === 'done') {
						<Icon name="check" size={18} />
					} @else {
						<Icon name="download" size={18} />
					}
					{phase === 'done'
						? t('sandbox.eject.delivered')
						: props.plan.modules.length === 1
							? t('sandbox.eject.title.one', { module: props.plan.moduleId })
							: t('sandbox.eject.title.other', {
									count: props.plan.modules.length,
								})}
				</span>
				<span class="sandbox__spacer"></span>
				<Tag mono>
					{git
						? git.branch
						: props.plan.modules.length === 1
							? props.plan.targetPath
							: t('sandbox.session.modules', {
									count: props.plan.modules.length,
								})}
				</Tag>
			</header>

			<div class="eject__body">
				@if (phase === 'plan') {
					<div class="eject__summary">
						@if (props.plan.availableTargets.length > 1) {
							<>
								<div
									class="ui-toolbar"
									role="radiogroup"
									aria-label={t('sandbox.eject.target.label')}
								>
									@for (const target of props.plan.availableTargets; key target.id) {
										<Button
											size="sm"
											variant={target.id === props.plan.target
												? 'primary'
												: 'secondary'}
											disabled={!target.available}
											onClick={() => props.onTarget(target.id)}
										>{t('sandbox.eject.' + TARGET_LABELS[target.id])}</Button>
									}
								</div>
								@for (const target of unavailable; key target.id) {
									<span class="ui-help">{t('sandbox.eject.target.unavailable', {
										target: t('sandbox.eject.' + TARGET_LABELS[target.id]),
										reason: target.reason ?? t('sandbox.eject.unknownReason'),
									})}</span>
								}
							</>
						}
						<p class="eject__lead">{lead(props.plan)}</p>
						<p class="ui-help">{explanation(props.plan)}</p>
						<ul class="eject__steps">
							@for (const module of props.plan.modules; key module.id) {
								<li class="eject__step">
									<span class="eject__step-label">
										{module.id + ' (' + module.targetPath + ')'}
									</span>
									<span class="eject__step-detail">{moduleDetail(module)}</span>
								</li>
							}
						</ul>
						@if (git) {
							<>
								<ul class="eject__steps">
									<li class="eject__step">
										<span class="eject__step-label">{t(
											'sandbox.eject.git.deliveryPath',
										)}</span>
										<span class="eject__step-detail">
											{git.deliveryMode === 'fork'
												? t('sandbox.eject.git.fork', {
														target: git.pushTarget,
														suffix: git.forkRequired
															? t('sandbox.eject.git.createdAfterConfirm')
															: '',
													})
												: t('sandbox.eject.git.directPush', {
														target: git.pushTarget,
													})}
										</span>
									</li>
									<li class="eject__step">
										<span class="eject__step-label">{t(
											'sandbox.eject.git.branch',
										)}</span>
										<span class="eject__step-detail">
											{git.branch +
												(git.head !== git.branch ? ` (${git.head})` : '')}
										</span>
									</li>
									<li class="eject__step">
										<span class="eject__step-label">{t(
											'sandbox.eject.git.base',
										)}</span>
										<span class="eject__step-detail">
											{git.remote + '/' + git.baseBranch}
										</span>
									</li>
									<li class="eject__step">
										<span class="eject__step-label">{t(
											'sandbox.eject.git.changedFiles',
										)}</span>
										<span class="eject__step-detail">{t(
											'sandbox.eject.git.changedFilesDetail',
											{
												changed: git.changedFiles,
												allowed: git.budget.maxChangedFiles,
											},
										)}</span>
									</li>
									@if (git.newDependencies.length > 0) {
										<li class="eject__step">
											<span class="eject__step-label">{t(
												'sandbox.eject.git.newPackages',
											)}</span>
											<span class="eject__step-detail">{t(
												'sandbox.eject.git.packagesDetail',
												{
													packages: git.newDependencies.join(', '),
													allowed: git.budget.maxNewDependencies,
												},
											)}</span>
										</li>
									}
									<li class="eject__step">
										<span class="eject__step-label">{t(
											'sandbox.eject.git.owners',
										)}</span>
										<span class="eject__step-detail">
											{git.owners.length > 0
												? git.owners.join(', ')
												: t('sandbox.eject.git.noOwners')}
										</span>
									</li>
									@if (git.reviewers.length > 0) {
										<li class="eject__step">
											<span class="eject__step-label">{t(
												'sandbox.eject.git.reviewers',
											)}</span>
											<span class="eject__step-detail">{git.reviewers.join(
												', ',
											)}</span>
										</li>
									}
									<li class="eject__step">
										<span class="eject__step-label">{t(
											'sandbox.eject.git.pullRequest',
										)}</span>
										<span class="eject__step-detail">
											{git.provider === 'github'
												? t('sandbox.eject.git.openedIn', {
														repository: git.repository ??
															t('sandbox.eject.git.configuredRepository'),
													})
												: git.providerNote}
										</span>
									</li>
								</ul>
								@if (blocked) {
									<Alert>{t('sandbox.eject.guardrails.blocked', {
										reasons: git.guardrails.reasons.join(' '),
									})}</Alert>
								} @else {
									<span class="ui-help">{t(
										'sandbox.eject.guardrails.passed',
									)}</span>
								}
							</>
						}
						<ul class="eject__steps">
							@for (const gate of props.plan.gates; key gate) {
								<li class="eject__step">
									<span class="eject__step-dot"></span>
									{t('sandbox.eject.step.gate', { gate })}
								</li>
							}
							@if (git) {
								<li class="eject__step">
									<span class="eject__step-dot"></span>
									{t('sandbox.eject.step.fetch', {
										base: `${git.remote}/${git.baseBranch}`,
										branch: git.branch,
									})}
								</li>
							}
							<li class="eject__step">
								<span class="eject__step-dot"></span>
								{t('sandbox.eject.step.copy')}
							</li>
							@if (totalRemoves(props.plan) > 0) {
								<li class="eject__step">
									<span class="eject__step-dot"></span>
									{t('sandbox.eject.step.remove', {
										count: totalRemoves(props.plan),
									})}
								</li>
							}
							@for (const module of props.plan.modules.filter(
								(entry) => entry.enable,
							); key module.id) {
								<li class="eject__step">
									<span class="eject__step-dot"></span>
									{t('sandbox.eject.step.enable', { module: module.id })}
								</li>
							}
							@if (!git) {
								<li class="eject__step">
									<span class="eject__step-dot"></span>
									{t('sandbox.eject.step.grant')}
								</li>
							}
							<li class="eject__step">
								<span class="eject__step-dot"></span>
								{t('sandbox.eject.step.typecheck')}
							</li>
							@if (git) {
								<>
									<li class="eject__step">
										<span class="eject__step-dot"></span>
										{t('sandbox.eject.step.guardrails')}
									</li>
									<li class="eject__step">
										<span class="eject__step-dot"></span>
										{t('sandbox.eject.step.push', {
											branch: git.branch,
											remote: git.remote,
										})}
									</li>
									<li class="eject__step">
										<span class="eject__step-dot"></span>
										{git.provider === 'github'
											? t('sandbox.eject.step.openPr')
											: t('sandbox.eject.step.compare')}
									</li>
								</>
							}
							@if (props.plan.restartRequired) {
								<li class="eject__step eject__step--note">
									<span class="eject__step-dot"></span>
									{props.plan.platformLocal
										? t('sandbox.eject.step.restart')
										: t('sandbox.eject.step.deploy')}
								</li>
							}
						</ul>
						@if (newPackagesOf(props.plan).length > 0 && !git) {
							<Alert tone="warning">{t('sandbox.eject.packagesWarning', {
								packages: newPackagesOf(props.plan).join(', '),
							})}</Alert>
						}
						@if (props.plan.previous) {
							<span class="ui-help">
								{t('sandbox.eject.previous', {
									date: deliveredAt(props.plan.previous.deliveredAt),
									branch: props.plan.previous.branch
										? t('sandbox.eject.previousBranch', {
												branch: props.plan.previous.branch,
											})
										: '',
								})}
								@if (props.plan.previous.pullRequestUrl) {
									<a
										href={props.plan.previous.pullRequestUrl}
										target="_blank"
										rel="noreferrer"
									>{t('sandbox.eject.openPreviousPr')}</a>
								}
							</span>
						}
						@if (!git) {
							<label class="ui-checkbox">
								<input
									type="checkbox"
									checked={props.build}
									onInput={(event) => props.onBuild(
										event.currentTarget.checked,
									)}
								/>
								<span>{t('sandbox.eject.build')}</span>
							</label>
						}
					</div>
				} @else {
					<ul class="eject__steps">
						@for (const step of props.steps; key step.id) {
							<li class={['eject__step', 'eject__step--' + step.status]}>
								<span
									class={[
										'eject__step-icon',
										step.status === 'running' && 'eject__step-icon--spin',
									]}
								>
									<Icon name={stepIcon(step.status)} size={14} />
								</span>
								<span class="eject__step-label">{step.label}</span>
								@if (step.detail) {
									<span class="eject__step-detail">{step.detail}</span>
								}
							</li>
						}
					</ul>
				}

				@if (phase === 'done' && props.summary) {
					<div class="eject__done">
						<b>
							{props.summary.branch
								? t('sandbox.eject.done.branch', {
										subject: delivered(props.summary),
										branch: props.summary.branch,
									})
								: t('sandbox.eject.done.workspace', {
										subject: delivered(props.summary),
										target: props.summary.modules.length === 1
											? props.summary.targetPath
											: t('sandbox.eject.thisWorkspace'),
									})}
						</b>
						<span class="ui-help">{t('sandbox.eject.done.summary', {
							files: props.summary.files,
							removed: props.summary.removed > 0
								? t('sandbox.eject.done.removed', {
										count: props.summary.removed,
									})
								: '',
							enabled: props.summary.enabled
								? t('sandbox.eject.done.enabled')
								: '',
						})}</span>
						@if (props.summary.pullRequestUrl) {
							<a
								class="ui-btn ui-btn--secondary ui-btn--sm"
								href={props.summary.pullRequestUrl}
								target="_blank"
								rel="noreferrer"
							>{t('sandbox.eject.openPr')}</a>
						} @else if (props.summary.compareUrl) {
							<a
								class="ui-btn ui-btn--secondary ui-btn--sm"
								href={props.summary.compareUrl}
								target="_blank"
								rel="noreferrer"
							>{t('sandbox.eject.openCompare')}</a>
						} @else if (props.summary.branch) {
							<span class="ui-help">{t('sandbox.eject.branchPushed')}</span>
						}
						@if (props.summary.restartRequired) {
							<span class="ui-help">
								{props.summary.platformLocal
									? t('sandbox.eject.restartNote')
									: t('sandbox.eject.deployNote')}
							</span>
						}
					</div>
				}
				@if (phase === 'failed') {
					<Alert>
						<span class="eject__error">{props.error}</span>
					</Alert>
				}
			</div>

			<footer class="eject__foot">
				@if (phase === 'plan') {
					<>
						<Button size="sm" variant="ghost" onClick={props.onClose}>{t(
							'sandbox.common.cancel',
						)}</Button>
						<Button
							size="sm"
							variant="primary"
							disabled={blocked}
							onClick={props.onConfirm}
						>
							<Icon name="download" size={14} />
							{git
								? git.provider === 'github'
									? t('sandbox.eject.confirmPr')
									: t('sandbox.eject.confirmBranch')
								: t('sandbox.eject.confirm')}
						</Button>
					</>
				} @else if (phase === 'running') {
					<span class="ui-help">{t('sandbox.eject.running')}</span>
				} @else {
					<Button size="sm" variant="primary" onClick={props.onClose}>{t(
						'sandbox.common.close',
					)}</Button>
				}
			</footer>
		</div>
	</div>
}
