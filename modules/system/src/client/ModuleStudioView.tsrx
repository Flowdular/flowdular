import { useMemo } from 'octane';
import { Alert, Button, EmptyState, Tag } from '@flowdular/ui';
import { t, workspaceViewHref } from '@flowdular/client';
import { cell, createStore, useValue } from 'segment-state';
import type { ModuleChangePlan } from '@flowdular/contracts';
import type { ModuleStudioState } from '../server/module-studio.ts';
import type { ModuleCatalogEntry } from './api.ts';

export interface ModuleStudioViewProps {
	readonly studio: ModuleStudioState;
	readonly modules: readonly ModuleCatalogEntry[];
	readonly sandboxAvailable: boolean;
	readonly commands: Readonly<Record<string, string>>;
}

function status(
	plan: ModuleChangePlan,
	installedHashes: ReadonlyMap<string, string>,
	modules: ReadonlyMap<string, ModuleCatalogEntry>,
) {
	const isInstalled = plan.releases.every(
		(release) => installedHashes.get(release.manifest.id) === release.sha256,
	);
	if (!isInstalled) return 'planned';
	if (
		plan.changes.every((change) => modules.get(change.id)?.active)
	) return 'active';
	if (
		plan.changes.every((change) => modules.get(change.id)?.enabled)
	) return 'enabled';
	return 'installed';
}

function sourceLabel(plan: ModuleChangePlan): string {
	return plan.source.kind === 'git'
		? `${plan.source.location} @ ${plan.source.commit}`
		: plan.source.location;
}

export function ModuleStudioView(props: ModuleStudioViewProps) @{
	const form = useMemo(
		() => createStore({
			target: cell(''),
			source: cell(''),
			copied: cell(false),
		}),
		[],
	);
	const [target, setTarget] = useValue(form.state.target);
	const [sourceName, setSourceName] = useValue(form.state.source);
	const [copied, setCopied] = useValue(form.state.copied);
	const selectedSource = sourceName || props.studio.sources[0]?.name || '';
	const validTarget =
		/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+(?:@[0-9]+\.[0-9]+\.[0-9]+)?$/.test(
			target.trim(),
		);
	const managedTarget = props.studio.installed.some(
		(entry) => entry.id === target.trim().split('@')[0],
	);
	const planCommand =
		validTarget && selectedSource
			? `pnpm flowdular module plan ${target.trim()} --source ${selectedSource}${
					managedTarget ? ' --update' : ''
				} --apply`
			: '';
	const copyPlanCommand = async () => {
		if (!planCommand) return;
		try {
			await navigator.clipboard.writeText(planCommand);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	};
	const installed = new Map(props.studio.installed.map(
		(entry) => [entry.id, entry.sha256],
	));
	const modules = new Map(props.modules.map((entry) => [entry.id, entry]));
	const statuses = new Map(props.studio.plans.map(
		(plan) => [plan.id, status(plan, installed, modules)],
	));
	<div class="ui-view">
		<section class="ui-card">
			<div class="ui-form">
				<div class="ui-form__section">
					<div class="ui-form__section-head">
						<b>{t('system.studio.title')}</b>
						<small>{t('system.studio.description')}</small>
					</div>
					<span class="ui-help">{t('system.studio.hostOnly')}</span>
					@if (props.sandboxAvailable) {
						<a
							class="ui-btn ui-btn--primary ui-btn--sm"
							href={workspaceViewHref('sandbox')}
						>{t('system.studio.openSandbox')}</a>
					}
					<pre class="ui-code">{props.commands.source ?? ''}</pre>
					@if (props.studio.sources.length > 0) {
						<>
							<label class="ui-field">
								<span>{t('system.studio.selectSource')}</span>
								<select
									class="ui-input"
									value={selectedSource}
									onChange={(event) => {
										setSourceName(
											(event.currentTarget as HTMLSelectElement).value,
										);
										setCopied(false);
									}}
								>
									@for (const source of props.studio.sources; key source.name) {
										<option value={source.name}>{source.name}</option>
									}
								</select>
							</label>
							<label class="ui-field">
								<span>{t('system.studio.target')}</span>
								<input
									class="ui-input ui-mono"
									value={target}
									placeholder="expenses.core@1.2.0"
									onInput={(event) => {
										setTarget((event.currentTarget as HTMLInputElement).value);
										setCopied(false);
									}}
								/>
							</label>
							@if (planCommand) {
								<>
									<pre class="ui-code">{planCommand}</pre>
									<Button size="sm" onClick={() => void copyPlanCommand()}>
										{copied
											? t('system.studio.copied')
											: t('system.studio.copyPlanCommand')}
									</Button>
								</>
							}
						</>
					}
				</div>
			</div>
		</section>
		@for (const issue of props.studio.issues; key issue) {
			<Alert tone="warning">{issue}</Alert>
		}
		<section class="ui-card">
			<div class="ui-form">
				<div class="ui-form__section">
					<div class="ui-form__section-head">
						<b>{t('system.studio.sources')}</b>
					</div>
					@if (props.studio.sources.length === 0) {
						<EmptyState icon="modules" title={t('system.studio.noSources')}>{t(
							'system.studio.noSourcesHint',
						)}</EmptyState>
					} @else {
						@for (const source of props.studio.sources; key source.name) {
							<span class="ui-cell">
								<b>{source.name}</b>
								<small class="ui-mono">{source.source.location}</small>
							</span>
						}
					}
				</div>
			</div>
		</section>
		<section class="ui-card">
			<div class="ui-form">
				<div class="ui-form__section">
					<div class="ui-form__section-head">
						<b>{t('system.studio.plans')}</b>
						<small>{t('system.studio.planCount', {
							count: props.studio.plans.length,
						})}</small>
					</div>
					@if (props.studio.plans.length === 0) {
						<EmptyState icon="modules" title={t('system.studio.noPlans')}>{t(
							'system.studio.noPlansHint',
						)}</EmptyState>
					} @else {
						@for (const plan of props.studio.plans; key plan.id) {
							<div class="ui-form__section">
								<div class="ui-form__section-head">
									<b>{plan.target}</b>
									<Tag
										tone={statuses.get(plan.id) === 'active'
											? 'success'
											: 'neutral'}
									>{t('system.studio.status.' + statuses.get(plan.id))}</Tag>
								</div>
								<span class="ui-cell">
									<small>{t('system.studio.source')}</small>
									<code class="ui-mono">{sourceLabel(plan)}</code>
								</span>
								<span class="ui-cell">
									<small>{t('system.studio.planId')}</small>
									<code class="ui-mono">{plan.id}</code>
								</span>
								@for (const change of plan.changes; key change.id) {
									<div class="ui-form__section">
										<b>{change.id} @ {change.version}</b>
										<span class="ui-cell">
											<small>{t('system.studio.artifact')}</small>
											<code class="ui-mono">{change.sha256}</code>
										</span>
										<span class="ui-cell">
											<small>{t('system.studio.dependencies')}</small>
											<span>
												{change.dependencies.join(', ') ||
													t('system.value.none')}
											</span>
										</span>
										<span class="ui-cell">
											<small>{t('system.studio.permissions')}</small>
											<span>
												{change.permissions.join(', ') ||
													t('system.value.none')}
											</span>
										</span>
										<span class="ui-cell">
											<small>{t('system.studio.migrations')}</small>
											<span>
												{change.migrations.map(
													(migration) =>
														`${migration.path} (${migration.sha256})`,
												).join(', ') ||
													t('system.value.none')}
											</span>
										</span>
										<span class="ui-cell">
											<small>{t('system.studio.surfaces')}</small>
											<span>
												{[
													change.surfaces.server
														? t('system.studio.server')
														: '',
													change.surfaces.client
														? t('system.studio.client')
														: '',
												].filter(Boolean).join(', ') ||
													t('system.value.none')}
											</span>
										</span>
									</div>
								}
								<span class="ui-help">{t('system.studio.impact')}</span>
								<pre
									class="ui-code"
								>{`pnpm flowdular module apply ${plan.id} --apply`}</pre>
								@for (const change of plan.changes; key change.id) {
									<pre
										class="ui-code"
									>{`pnpm flowdular module enable ${change.id} --apply`}</pre>
								}
								<span class="ui-help">{t('system.studio.preview')}</span>
								<pre class="ui-code">pnpm dev</pre>
							</div>
						}
					}
				</div>
			</div>
		</section>
	</div>
}
