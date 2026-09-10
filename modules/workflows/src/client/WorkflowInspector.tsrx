import { t } from '@flowdular/client';
import { Alert, Button, FormField, Icon, Tag } from '@flowdular/ui';
import type {
	WorkflowActionNodeV1,
	WorkflowAgentDecisionNodeV1,
	WorkflowAgentNodeV1,
	WorkflowEdgeV1,
	WorkflowGraphV1,
	WorkflowNodeFailurePolicyV1,
	WorkflowNodeV1,
} from '../domain/types.ts';
import type {
	WorkflowActionCatalogItem,
	WorkflowAgentCatalogItem,
} from './api.ts';

import { WorkflowMappingEditor } from './WorkflowMappingEditor.tsrx';
import { WorkflowInputSchemaEditor } from './WorkflowInputSchemaEditor.tsrx';

export interface WorkflowInspectorProps {
	readonly graph: WorkflowGraphV1;
	readonly node: WorkflowNodeV1 | null;
	readonly edge: WorkflowEdgeV1 | null;
	readonly agents: readonly WorkflowAgentCatalogItem[];
	readonly actions: readonly WorkflowActionCatalogItem[];
	readonly editable: boolean;
	readonly onReplaceNode: (node: WorkflowNodeV1) => void;
	readonly onReplaceGraph: (graph: WorkflowGraphV1) => void;
	readonly onRemoveNode: (nodeId: string) => void;
	readonly onRemoveEdge: (edgeId: string) => void;
}

const DEFAULT_FAILURE_POLICY: WorkflowNodeFailurePolicyV1 = {
	maxAttempts: 1,
	retryOn: [],
	backoff: { kind: 'fixed', initialMs: 1_000, maximumMs: 30_000 },
	onExhausted: 'emit-failure',
};

function boundedInteger(
	value: string,
	minimum: number,
	maximum: number,
): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return minimum;
	return Math.min(maximum, Math.max(minimum, parsed));
}

function FailurePolicyEditor(props: {
	readonly node: | WorkflowAgentNodeV1
	| WorkflowAgentDecisionNodeV1
	| WorkflowActionNodeV1;
	readonly editable: boolean;
	readonly onChange: (node: WorkflowNodeV1) => void;
}) @{
	const policy = props.node.failurePolicy ?? DEFAULT_FAILURE_POLICY;
	const replace = (next: WorkflowNodeFailurePolicyV1) => props.onChange({
		...props.node,
		failurePolicy: next,
	});

	<div class="ui-form__section">
		<div class="ui-form__section-head">
			<b>{t('workflows.inspector.retryPolicy')}</b>
			<small>{t('workflows.inspector.retryPolicyHelp')}</small>
		</div>
		<FormField label={t('workflows.inspector.maxAttempts')}>
			<input
				class="ui-input"
				type="number"
				min="1"
				max="5"
				value={policy.maxAttempts}
				disabled={!props.editable}
				onInput={(event) => replace({
					...policy,
					maxAttempts: boundedInteger(event.currentTarget.value, 1, 5),
				})}
			/>
		</FormField>
		<FormField
			label={t('workflows.inspector.retryOn')}
			help={t('workflows.inspector.retryOnHelp')}
		>
			<input
				class="ui-input ui-mono"
				value={policy.retryOn.join(', ')}
				disabled={!props.editable}
				onInput={(event) => replace({
					...policy,
					retryOn: event.currentTarget.value.split(',').map(
						(entry) => entry.trim(),
					).filter(Boolean),
				})}
			/>
		</FormField>
		<div class="workflow-policy-grid">
			<FormField label={t('workflows.inspector.backoff')}>
				<select
					class="ui-select"
					value={policy.backoff.kind}
					disabled={!props.editable}
					onInput={(event) => replace({
						...policy,
						backoff: {
							...policy.backoff,
							kind: event.currentTarget.value === 'exponential'
								? 'exponential'
								: 'fixed',
						},
					})}
				>
					<option value="fixed">{t('workflows.inspector.backoffFixed')}</option>
					<option value="exponential">{t(
						'workflows.inspector.backoffExponential',
					)}</option>
				</select>
			</FormField>
			<FormField label={t('workflows.inspector.initialDelay')}>
				<input
					class="ui-input"
					type="number"
					min="0"
					max="3600000"
					value={policy.backoff.initialMs}
					disabled={!props.editable}
					onInput={(event) => replace({
						...policy,
						backoff: {
							...policy.backoff,
							initialMs: boundedInteger(
								event.currentTarget.value,
								0,
								3_600_000,
							),
						},
					})}
				/>
			</FormField>
			<FormField label={t('workflows.inspector.maximumDelay')}>
				<input
					class="ui-input"
					type="number"
					min="0"
					max="3600000"
					value={policy.backoff.maximumMs}
					disabled={!props.editable}
					onInput={(event) => replace({
						...policy,
						backoff: {
							...policy.backoff,
							maximumMs: boundedInteger(
								event.currentTarget.value,
								0,
								3_600_000,
							),
						},
					})}
				/>
			</FormField>
		</div>
		<FormField label={t('workflows.inspector.onExhausted')}>
			<select
				class="ui-select"
				value={policy.onExhausted}
				disabled={!props.editable}
				onInput={(event) => replace({
					...policy,
					onExhausted: event.currentTarget.value === 'fail-run'
						? 'fail-run'
						: 'emit-failure',
				})}
			>
				<option value="emit-failure">{t(
					'workflows.inspector.emitFailure',
				)}</option>
				<option value="fail-run">{t('workflows.inspector.failRun')}</option>
			</select>
		</FormField>
	</div>
}

function AgentReferenceEditor(props: {
	readonly node: WorkflowAgentNodeV1 | WorkflowAgentDecisionNodeV1;
	readonly agents: readonly WorkflowAgentCatalogItem[];
	readonly editable: boolean;
	readonly onChange: (node: WorkflowNodeV1) => void;
}) @{
	const selectedAgent = props.agents.find(
		(agent) =>
			agent.agentId === props.node.agent.agentId &&
				agent.revision === props.node.agent.revision,
	);
	const allowedTools = selectedAgent?.allowedTools ?? [];
	const toggleTool = (tool: string, granted: boolean) => {
		const next =
			granted
				? [...new Set([...props.node.toolGrants, tool])].sort()
				: props.node.toolGrants.filter((entry) => entry !== tool);
		props.onChange({ ...props.node, toolGrants: next });
	};

	<>
		<FormField
			label={t('workflows.inspector.agent')}
			help={t('workflows.inspector.agentHelp')}
		>
			<select
				class="ui-select"
				disabled={!props.editable}
				value={`${props.node.agent.agentId}@${props.node.agent.revision}`}
				onInput={(event) => {
					const selected = props.agents.find(
						(agent) =>
							`${agent.agentId}@${agent.revision}` ===
								event.currentTarget.value,
					);
					if (selected) props.onChange({
						...props.node,
						agent: { agentId: selected.agentId, revision: selected.revision },
						toolGrants: props.node.toolGrants.filter(
							(tool) => selected.allowedTools.includes(tool),
						),
					});
				}}
			>
				<option value="">{t('workflows.inspector.chooseAgent')}</option>
				@for (const agent of props.agents; key agent.agentId + '@' +
					agent.revision) {
					<option value={`${agent.agentId}@${agent.revision}`}>
						{agent.name + ' · r' + agent.revision}
					</option>
				}
			</select>
		</FormField>
		<div class="ui-form__section">
			<div class="ui-form__section-head">
				<b>{t('workflows.inspector.toolGrants')}</b>
				<small>{t('workflows.inspector.toolGrantsHelp')}</small>
			</div>
			@if (allowedTools.length === 0) {
				<small>{t('workflows.inspector.noAgentTools')}</small>
			} @else {
				<div class="workflow-tool-grants">
					@for (const tool of allowedTools; key tool) {
						<label class="workflow-tool-grant">
							<input
								type="checkbox"
								checked={props.node.toolGrants.includes(tool)}
								disabled={!props.editable}
								onInput={(event) => toggleTool(
									tool,
									event.currentTarget.checked,
								)}
							/>
							<code class="ui-mono">{tool}</code>
						</label>
					}
				</div>
			}
		</div>
	</>
}

function ActionReferenceEditor(props: {
	readonly node: WorkflowActionNodeV1;
	readonly actions: readonly WorkflowActionCatalogItem[];
	readonly editable: boolean;
	readonly onChange: (node: WorkflowNodeV1) => void;
}) @{
	<FormField
		label={t('workflows.inspector.action')}
		help={t('workflows.inspector.actionHelp')}
	>
		<select
			class="ui-select"
			disabled={!props.editable}
			value={`${props.node.action.actionId}@${props.node.action.contractVersion}`}
			onInput={(event) => {
				const selected = props.actions.find(
					(action) =>
						`${action.actionId}@${action.contractVersion}` ===
							event.currentTarget.value,
				);
				if (selected) props.onChange({
					...props.node,
					action: {
						actionId: selected.actionId,
						contractVersion: selected.contractVersion,
					},
				});
			}}
		>
			<option value="">{t('workflows.inspector.chooseAction')}</option>
			@for (const action of props.actions; key action.actionId + '@' +
				action.contractVersion) {
				<option value={`${action.actionId}@${action.contractVersion}`}>
					{action.label + ' · v' + action.contractVersion}
				</option>
			}
		</select>
	</FormField>
}

export function WorkflowInspector(props: WorkflowInspectorProps) @{
	@if (props.edge) {
		<aside class="workflow-inspector">
			<div class="workflow-panel-head">
				<b>{t('workflows.inspector.edgeTitle')}</b>
				<small class="ui-mono">{props.edge.id}</small>
			</div>
			<div class="workflow-inspector__body">
				<div class="workflow-connection-summary">
					<code class="ui-mono">
						{props.edge.source.nodeId + '.' + props.edge.source.port}
					</code>
					<Icon name="external" size={16} />
					<code class="ui-mono">
						{props.edge.target.nodeId + '.' + props.edge.target.port}
					</code>
				</div>
				@if (props.editable) {
					<Button
						variant="danger"
						onClick={() => props.onRemoveEdge(props.edge!.id)}
					>{t('workflows.inspector.removeEdge')}</Button>
				}
			</div>
		</aside>
	} @else if (props.node) {
		<aside class="workflow-inspector">
			<div class="workflow-panel-head workflow-panel-head--row">
				<span class="ui-cell">
					<b>{t('workflows.inspector.nodeTitle')}</b>
					<small class="ui-mono">{props.node.id}</small>
				</span>
				<Tag tone="neutral">{t('workflows.nodeType.' + props.node.type)}</Tag>
			</div>
			<div class="workflow-inspector__body ui-form">
				<FormField label={t('workflows.inspector.label')}>
					<input
						class="ui-input"
						value={props.node.label}
						disabled={!props.editable}
						maxlength={120}
						onInput={(event) => props.onReplaceNode(
							{
								...props.node!,
								label: event.currentTarget.value,
							} as WorkflowNodeV1,
						)}
					/>
				</FormField>
				@if (
					props.node.type === 'agent' || props.node.type === 'agent-decision'
				) {
					<AgentReferenceEditor
						node={props.node}
						agents={props.agents}
						editable={props.editable}
						onChange={props.onReplaceNode}
					/>
				}
				@if (props.node.type === 'action') {
					<ActionReferenceEditor
						node={props.node}
						actions={props.actions}
						editable={props.editable}
						onChange={props.onReplaceNode}
					/>
				}
				@if (
					props.node.type === 'agent' || props.node.type === 'agent-decision' ||
						props.node.type === 'action'
				) {
					<FailurePolicyEditor
						node={props.node}
						editable={props.editable}
						onChange={props.onReplaceNode}
					/>
				}
				@if (props.node.type === 'validator') {
					<FormField label={t('workflows.inspector.schema')}>
						<select
							class="ui-select"
							value={props.node.schemaId}
							disabled={!props.editable}
							onInput={(event) => props.onReplaceNode(
								{
									...props.node!,
									schemaId: event.currentTarget.value,
								} as WorkflowNodeV1,
							)}
						>
							@for (const schemaId of Object.keys(
								props.graph.schemas,
							); key schemaId) {
								<option value={schemaId}>{schemaId}</option>
							}
						</select>
					</FormField>
				}
				@if (props.node.type === 'gate') {
					<FormField
						label={t('workflows.inspector.gatePointer')}
						help={t('workflows.inspector.gatePointerHelp')}
					>
						<input
							class="ui-input ui-mono"
							value={props.node.expression.op === 'exists' &&
							props.node.expression.value.op === 'path'
								? props.node.expression.value.pointer
								: '/'}
							disabled={!props.editable}
							onInput={(event) => props.onReplaceNode(
								{
									...props.node!,
									expression: {
										op: 'exists',
										value: { op: 'path', pointer: event.currentTarget.value },
									},
								} as WorkflowNodeV1,
							)}
						/>
					</FormField>
				}
				@if (props.node.type === 'input') {
					<WorkflowInputSchemaEditor
						schema={props.graph.schemas[props.node.outputPorts[0]?.schemaId ??
							''] ??
							{}}
						editable={props.editable}
						onChange={(schema) => props.onReplaceGraph({
							...props.graph,
							schemas: {
								...props.graph.schemas,
								[props.node!.outputPorts[0]!.schemaId]: schema,
							},
						})}
					/>
				}
				<WorkflowMappingEditor
					key={props.node.id}
					graph={props.graph}
					node={props.node}
					editable={props.editable}
					onChange={props.onReplaceNode}
				/>
				@if (props.editable) {
					<div class="ui-form__section ui-form__section--danger">
						<div class="ui-form__section-head">
							<b>{t('workflows.inspector.removeNodeTitle')}</b>
							<small>{t('workflows.inspector.removeNodeDescription')}</small>
						</div>
						<div class="ui-form__actions">
							<Button
								variant="danger"
								onClick={() => props.onRemoveNode(props.node!.id)}
							>{t('workflows.inspector.removeNode')}</Button>
						</div>
					</div>
				}
			</div>
		</aside>
	} @else {
		<aside class="workflow-inspector">
			<Alert tone="info">{t('workflows.inspector.empty')}</Alert>
		</aside>
	}
}
