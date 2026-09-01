import { Alert, Button, Icon, Tag } from '@coreloom/ui';
import type {
	EjectPlanView,
	EjectStep,
	EjectSummary,
	EjectTargetId,
} from './api.ts';

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
	workspace: 'Into this workspace',
	'git-pr': 'As a pull request',
};

function stepIcon(status: EjectStep['status']): string {
	if (status === 'passed') return 'check';
	if (status === 'failed') return 'alert';
	if (status === 'note') return 'help';
	return 'refresh';
}

function others(plan: EjectPlanView): string {
	const count = plan.modules.length - 1;
	return count > 0
		? `, plus ${count} more module${
				count === 1 ? '' : 's'
			} in the same delivery`
		: '';
}

function lead(plan: EjectPlanView): string {
	if (plan.git) {
		return `${plan.git.changedFiles} files change on ${plan.git.branch}, branched from ${plan.git.remote}/${plan.git.baseBranch}${others(
			plan,
		)}. Nothing in this workspace changes.`;
	}
	const parts = [
		`${plan.files.length} files land in ${plan.targetPath}`,
		...(plan.overwrites.length > 0
			? [`${plan.overwrites.length} of them overwritten`]
			: []),
		...(plan.removes.length > 0
			? [`${plan.removes.length} deleted files removed`]
			: []),
	];
	return `${parts.join(', ')}${others(plan)}.`;
}

function explanation(plan: EjectPlanView): string {
	if (plan.git) {
		return 'Every gate runs first. The modules are then copied into a clean worktree of the base branch, dependencies are linked, new modules are enabled, the platform is typechecked, and the change is checked against the allowed paths and the budget. Only then is it committed and pushed. A failing step stops the delivery, removes the worktree, and nothing is marked delivered.';
	}
	return plan.enable
		? 'Every gate runs first. The module is then copied, its dependencies are linked, and it is enabled through the module capability. A failing step stops the delivery and nothing is marked delivered.'
		: 'Every gate runs first. The module is then copied and its dependencies are linked. A failing step stops the delivery and nothing is marked delivered.';
}

function deliveredAt(at: number): string {
	return new Date(at).toLocaleString();
}

/* Eject is a delivery, so it gets its own screen: what will land, every step
   while it lands, and a plain confirmation when it has. */
export function EjectModal(props: EjectModalProps) @{
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
					{phase === 'done' ? 'Delivered' : 'Eject ' + props.plan.moduleId}
				</span>
				<span class="sandbox__spacer"></span>
				<Tag mono>
					{git ? git.branch : props.plan.targetPath}
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
									aria-label="Delivery target"
								>
									@for (const target of props.plan.availableTargets; key target.id) {
										<Button
											size="sm"
											variant={target.id === props.plan.target
												? 'primary'
												: 'secondary'}
											disabled={!target.available}
											onClick={() => props.onTarget(target.id)}
										>{TARGET_LABELS[target.id]}</Button>
									}
								</div>
								@for (const target of unavailable; key target.id) {
									<span class="ui-help">
										{TARGET_LABELS[target.id] + ' is not available: ' +
											(target.reason ?? 'unknown reason')}
									</span>
								}
							</>
						}
						<p class="eject__lead">{lead(props.plan)}</p>
						<p class="ui-help">{explanation(props.plan)}</p>
						@if (git) {
							<>
								<ul class="eject__steps">
									<li class="eject__step">
										<span class="eject__step-label">Branch</span>
										<span class="eject__step-detail">{git.branch}</span>
									</li>
									<li class="eject__step">
										<span class="eject__step-label">Base</span>
										<span class="eject__step-detail">
											{git.remote + '/' + git.baseBranch}
										</span>
									</li>
									<li class="eject__step">
										<span class="eject__step-label">Changed files</span>
										<span class="eject__step-detail">
											{git.changedFiles + ' of ' + git.budget.maxChangedFiles +
												' allowed (estimate; the guardrail step counts the real worktree)'}
										</span>
									</li>
									@if (git.newDependencies.length > 0) {
										<li class="eject__step">
											<span class="eject__step-label">New packages</span>
											<span class="eject__step-detail">
												{git.newDependencies.join(', ') + ' (' +
													git.budget.maxNewDependencies +
													' allowed)'}
											</span>
										</li>
									}
									<li class="eject__step">
										<span class="eject__step-label">Owners touched</span>
										<span class="eject__step-detail">
											{git.owners.length > 0
												? git.owners.join(', ')
												: 'none listed in path-ownership.yaml'}
										</span>
									</li>
									@if (git.reviewers.length > 0) {
										<li class="eject__step">
											<span class="eject__step-label">Reviewers</span>
											<span class="eject__step-detail">{git.reviewers.join(
												', ',
											)}</span>
										</li>
									}
									<li class="eject__step">
										<span class="eject__step-label">Pull request</span>
										<span class="eject__step-detail">
											{git.provider === 'github'
												? 'opened with gh'
												: git.providerNote}
										</span>
									</li>
								</ul>
								@if (blocked) {
									<Alert>
										{'The guardrails block this delivery: ' +
											git.guardrails.reasons.join(' ')}
									</Alert>
								} @else {
									<span class="ui-help">
										Guardrails: within the allowed paths and the budget.
									</span>
								}
							</>
						}
						<ul class="eject__steps">
							@for (const gate of props.plan.gates; key gate) {
								<li class="eject__step">
									<span class="eject__step-dot"></span>
									{'Gate ' + gate}
								</li>
							}
							@if (git) {
								<li class="eject__step">
									<span class="eject__step-dot"></span>
									{'Fetch ' + git.remote + '/' + git.baseBranch +
										' and prepare a clean worktree on ' +
										git.branch}
								</li>
							}
							<li class="eject__step">
								<span class="eject__step-dot"></span>
								Copy, then link dependencies with pnpm install
							</li>
							@if (props.plan.removes.length > 0) {
								<li class="eject__step">
									<span class="eject__step-dot"></span>
									{'Remove ' + props.plan.removes.length +
										' files the session deleted: ' +
										props.plan.removes.slice(0, 5).join(', ') +
										(props.plan.removes.length > 5 ? ', …' : '')}
								</li>
							}
							@if (props.plan.enable) {
								<li class="eject__step">
									<span class="eject__step-dot"></span>
									Enable the module in the platform
								</li>
							}
							@if (!git) {
								<li class="eject__step">
									<span class="eject__step-dot"></span>
									Grant the module scopes to workspace owners
								</li>
							}
							<li class="eject__step">
								<span class="eject__step-dot"></span>
								Typecheck the platform with the module in it
							</li>
							@if (git) {
								<>
									<li class="eject__step">
										<span class="eject__step-dot"></span>
										Check the change against the allowed paths and the budget
									</li>
									<li class="eject__step">
										<span class="eject__step-dot"></span>
										{'Commit and push ' + git.branch + ' to ' + git.remote}
									</li>
									<li class="eject__step">
										<span class="eject__step-dot"></span>
										{git.provider === 'github'
											? 'Open the pull request'
											: 'Show the compare link'}
									</li>
								</>
							}
							@if (props.plan.restartRequired) {
								<li class="eject__step eject__step--note">
									<span class="eject__step-dot"></span>
									{props.plan.platformLocal
										? 'Then restart the application so it loads the new composition and migrations'
										: 'Then deploy the workspace; the connected application runs elsewhere'}
								</li>
							}
						</ul>
						@if (props.plan.newPackages.length > 0 && !git) {
							<Alert tone="warning">
								{'This module adds packages the workspace does not have yet: ' +
									props.plan.newPackages.join(', ') +
									'. They are installed during the eject.'}
							</Alert>
						}
						@if (props.plan.previous) {
							<span class="ui-help">
								{'Delivered before, on ' +
									deliveredAt(props.plan.previous.deliveredAt) +
									(props.plan.previous.branch
										? ' as ' + props.plan.previous.branch
										: '') +
									'. '}
								@if (props.plan.previous.pullRequestUrl) {
									<a
										href={props.plan.previous.pullRequestUrl}
										target="_blank"
										rel="noreferrer"
									>
										Open that pull request
									</a>
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
								<span>Build the platform afterwards (slower)</span>
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
								? props.summary.moduleId + ' is on ' + props.summary.branch
								: props.summary.moduleId + ' is in ' + props.summary.targetPath}
						</b>
						<span class="ui-help">
							{props.summary.files + ' files delivered' +
								(props.summary.removed > 0
									? ', ' + props.summary.removed + ' removed'
									: '') +
								(props.summary.enabled
									? ' and the module is enabled in the platform.'
									: '.')}
						</span>
						@if (props.summary.pullRequestUrl) {
							<a
								class="ui-btn ui-btn--secondary ui-btn--sm"
								href={props.summary.pullRequestUrl}
								target="_blank"
								rel="noreferrer"
							>
								Open the pull request
							</a>
						} @else if (props.summary.compareUrl) {
							<a
								class="ui-btn ui-btn--secondary ui-btn--sm"
								href={props.summary.compareUrl}
								target="_blank"
								rel="noreferrer"
							>
								Open the compare view to create the pull request
							</a>
						} @else if (props.summary.branch) {
							<span class="ui-help">
								The branch is pushed. Open a pull request from it in your git
								host.
							</span>
						}
						@if (props.summary.restartRequired) {
							<span class="ui-help">
								{props.summary.platformLocal
									? 'Restart the application (pnpm dev) to load the new composition and run its migrations.'
									: 'Deploy the workspace for the connected application to pick the change up.'}
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
						<Button size="sm" variant="ghost" onClick={props.onClose}>
							Cancel
						</Button>
						<Button
							size="sm"
							variant="primary"
							disabled={blocked}
							onClick={props.onConfirm}
						>
							<Icon name="download" size={14} />
							{git
								? 'Run gates and open the pull request'
								: 'Run gates and deliver'}
						</Button>
					</>
				} @else if (phase === 'running') {
					<span class="ui-help">Delivering. This runs every gate first.</span>
				} @else {
					<Button size="sm" variant="primary" onClick={props.onClose}>
						Close
					</Button>
				}
			</footer>
		</div>
	</div>
}
