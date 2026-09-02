import { t } from '@coreloom/client';
import { Button, Drawer, EmptyState, FormField, Tag } from '@coreloom/ui';
import type {
	JsonValue,
	WorkflowGraphV1,
	WorkflowSimulationFixture,
} from '../domain/types.ts';
import { simulationFixtures } from './canvas-model.ts';

function readFixtures(
	value: string,
	graph: WorkflowGraphV1,
): readonly WorkflowSimulationFixture[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (Array.isArray(parsed)) return parsed as WorkflowSimulationFixture[];
	} catch {
		/* The structured editor recovers from stale raw fixture text. */
	}
	return simulationFixtures(graph);
}

function replaceFixture(
	value: string,
	graph: WorkflowGraphV1,
	nodeId: string,
	replace: (fixture: WorkflowSimulationFixture) => WorkflowSimulationFixture,
): string {
	const defaults = simulationFixtures(graph);
	const fixtures = [...readFixtures(value, graph)];
	const index = fixtures.findIndex((fixture) => fixture.nodeId === nodeId);
	const current =
		index >= 0
			? fixtures[index]!
			: defaults.find((fixture) => fixture.nodeId === nodeId) ?? { nodeId };
	const next = replace(current);
	if (index >= 0) fixtures[index] = next;
	else fixtures.push(next);
	return JSON.stringify(fixtures, null, 2);
}

export function WorkflowFixtureDrawer(props: {
	readonly open: boolean;
	readonly graph: WorkflowGraphV1 | null;
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly onClose: () => void;
}) @{
	const graph = props.graph;
	const fixtures =
		graph ? readFixtures(props.value, graph) : [];
	const nodes = (graph?.nodes ?? []).filter(
		(node) => ['agent', 'agent-decision', 'action'].includes(node.type),
	).map(
		(node) => ({
			key: node.id,
			node,
			fixture: fixtures.find((fixture) => fixture.nodeId === node.id) ??
				{
					nodeId: node.id,
					outcomePort: node.type === 'agent-decision' ? 'pass' : 'success',
					output: {} as JsonValue,
					simulatedDurationMs: 500,
				},
		}),
	);

	<Drawer
		open={props.open}
		title={t('workflows.fixtures.title')}
		subtitle={t('workflows.fixtures.subtitle')}
		onClose={props.onClose}
	>
		<div class="ui-form workflow-fixture-list">
			@if (nodes.length === 0) {
				<EmptyState icon="flask" title={t('workflows.fixtures.title')}>{t(
					'workflows.fixtures.empty',
				)}</EmptyState>
			} @else {
				@for (const entry of nodes; key entry.key) {
					<section class="workflow-fixture-card">
						<div class="workflow-panel-head workflow-panel-head--row">
							<span class="ui-cell">
								<b>{entry.node.label}</b>
								<small class="ui-mono">{entry.node.id}</small>
							</span>
							<Tag tone="neutral">{t(
								'workflows.nodeType.' + entry.node.type,
							)}</Tag>
						</div>
						<div class="workflow-fixture-card__grid">
							<FormField label={t('workflows.fixtures.outcome')}>
								<select
									class="ui-select"
									value={entry.fixture.outcomePort ?? ''}
									onInput={(event) => {
										if (!graph) return;
										props.onChange(
											replaceFixture(
												props.value,
												graph,
												entry.node.id,
												(fixture) => ({
													...fixture,
													outcomePort: event.currentTarget.value,
												}),
											),
										);
									}}
								>
									@for (const port of entry.node.outputPorts; key port.name) {
										<option value={port.name}>{port.name}</option>
									}
								</select>
							</FormField>
							<FormField label={t('workflows.fixtures.duration')}>
								<input
									class="ui-input"
									type="number"
									min="0"
									max="3600000"
									value={entry.fixture.simulatedDurationMs ?? 0}
									onInput={(event) => {
										if (!graph) return;
										const duration = Math.min(
											3_600_000,
											Math.max(
												0,
												Number.parseInt(event.currentTarget.value, 10) || 0,
											),
										);
										props.onChange(
											replaceFixture(
												props.value,
												graph,
												entry.node.id,
												(fixture) => ({
													...fixture,
													simulatedDurationMs: duration,
												}),
											),
										);
									}}
								/>
							</FormField>
						</div>
						<FormField
							label={t('workflows.fixtures.failure')}
							help={t('workflows.fixtures.failurePlaceholder')}
						>
							<input
								class="ui-input ui-mono"
								value={entry.fixture.failureCode ?? ''}
								onInput={(event) => {
									if (!graph) return;
									const value = event.currentTarget.value.trim();
									props.onChange(
										replaceFixture(props.value, graph, entry.node.id, (
											fixture,
										) => {
											const { failureCode: _failureCode, ...rest } = fixture;
											return value ? { ...rest, failureCode: value } : rest;
										}),
									);
								}}
							/>
						</FormField>
						<FormField label={t('workflows.fixtures.output')}>
							<textarea
								class="ui-textarea ui-mono"
								value={JSON.stringify(entry.fixture.output ?? {}, null, 2)}
								spellcheck="false"
								onInput={(event) => {
									if (!graph) return;
									try {
										const output = JSON.parse(
											event.currentTarget.value,
										) as JsonValue;
										event.currentTarget.setCustomValidity('');
										props.onChange(
											replaceFixture(
												props.value,
												graph,
												entry.node.id,
												(fixture) => ({ ...fixture, output }),
											),
										);
									} catch {
										event.currentTarget.setCustomValidity(
											t('workflows.fixtures.invalidOutput'),
										);
									}
								}}
							/>
						</FormField>
					</section>
				}
			}
			<div class="ui-form__actions">
				<Button variant="primary" onClick={props.onClose}>{t(
					'workflows.fixtures.close',
				)}</Button>
			</div>
		</div>
	</Drawer>
}
