import type {
	DataClassDeclaration,
	DataClassExportSummary,
} from '@flowdular/kernel';
import type {
	WorkflowDefinition,
	WorkflowEdgeTransfer,
	WorkflowNodeExecution,
	WorkflowRevision,
} from '../domain/types.ts';
import type {
	WorkflowDefinitionExportCursor,
	WorkflowRunExportCursor,
	WorkflowRunRecord,
	WorkflowsRepository,
} from './repository.ts';

/** Rows one keyset page carries. Bounded so a walk never loads a whole table. */
export const EXPORT_PAGE = 500;

/**
 * Days a run is kept, per D-AUDIT-RETENTION-DEFAULTS. The period covers the
 * whole run: the run record, its node states and attempts, its edge evidence,
 * its ordered events and the sealed execution payloads it still holds.
 */
export const RUN_RETENTION_DAYS = 90;

/**
 * The classes workflows.core owns.
 *
 * `runs` is what a workspace accumulates. Only a settled run is swept, so a
 * run still working, waiting on a child or asleep on an approval is never
 * taken out from under its worker, and the export walks the run order the
 * queue index already carries. The export carries the redacted evidence a run
 * recorded and never the sealed execution payload: the archive is read by
 * people the preview was already filtered for.
 *
 * `audit-events` carries no sweep. The trail is hash chained per workspace,
 * every event naming the hash of the one before it, and verifyAudit walks it
 * from sequence 1 with no previous hash. Deleting the oldest events by age
 * would leave the first surviving event pointing at a row that is gone, so the
 * next verification would report the chain broken and could not tell retention
 * from tampering. agents.core, automations.core and audit.core keep their
 * chained ledgers for the same reason. The precise fix is chain archival,
 * sealing a removed prefix under one anchor event; until that exists these rows
 * are kept until a person deletes them.
 *
 * `definitions` is the workspace's configuration rather than history, so it is
 * kept until a person deletes it and carries no sweep; a retention pass that
 * removed a published workflow would stop the automations pointing at it. The
 * export carries the published revision of each workflow, which the module's
 * own invariants keep free of secrets: a value marked secret never enters a
 * workflow definition. A draft is not exported, because it is the editor's
 * work in progress rather than what the workspace runs.
 *
 * The repository arrives as a thunk because declaring happens while the
 * platform composes, before anything has opened a database.
 */
export function workflowsDataClasses(
	repository: () => Promise<WorkflowsRepository>,
	pageSize = EXPORT_PAGE,
): readonly DataClassDeclaration[] {
	return [
		{
			key: 'runs',
			label: 'Workflow runs',
			defaultRetentionDays: RUN_RETENTION_DAYS,
			exportable: true,
			sweep: async ({ tenantId, cutoff, limit }) => ({
				removed: await (
					await repository()
				).deleteRunsSettledBefore(tenantId, cutoff.getTime(), limit),
			}),
			/* The runs one account is the person behind, in any state: the ones it
			   started itself and the ones a schedule, a webhook, an automation or
			   an agent started on its behalf, which carry the person in the actor's
			   configuredBy and in the authorization subject rather than in the
			   actor's own id. A run this removes while a worker holds it is the
			   lost-lease case that worker already handles, so an erasure never
			   waits for the queue to drain. */
			erase: async ({ tenantId, subject, limit }) => {
				const removed = await (
					await repository()
				).deleteRunsOfSubject(tenantId, subject.accountId, limit);
				/* A full batch may have left more behind; the caller repeats and
				   the next batch answers zero. Over-reporting one repeat is
				   cheaper than reporting a subject as cleared while rows remain. */
				return removed === limit ? { removed, truncated: true } : { removed };
			},
			export: async ({ tenantId, sink }): Promise<DataClassExportSummary> => {
				let after: WorkflowRunExportCursor | null = null;
				let rows = 0;
				let from: Date | null = null;
				let to: Date | null = null;
				for (;;) {
					const page = await (
						await repository()
					).exportRunsPage(tenantId, after, pageSize);
					for (const { run, nodes, edges } of page) {
						const at = new Date(run.queuedAt);
						if (!from || at < from) from = at;
						if (!to || at > to) to = at;
						after = { queuedAt: run.queuedAt, id: run.id };
						rows += 1;
						await sink.write(runRow(run, nodes, edges));
					}
					if (page.length < pageSize) return { rows, from, to };
				}
			},
		},
		{
			key: 'audit-events',
			label: 'Workflow audit trail',
			defaultRetentionDays: null,
			exportable: true,
			export: async ({ tenantId, sink }): Promise<DataClassExportSummary> => {
				let afterSequence = 0;
				let rows = 0;
				let from: Date | null = null;
				let to: Date | null = null;
				for (;;) {
					const page = await (
						await repository()
					).exportAuditEventsPage(tenantId, afterSequence, pageSize);
					for (const event of page) {
						const at = new Date(event.occurredAt);
						if (!from || at < from) from = at;
						if (!to || at > to) to = at;
						afterSequence = event.sequence;
						rows += 1;
						await sink.write({ ...event, occurredAt: at.toISOString() });
					}
					if (page.length < pageSize) return { rows, from, to };
				}
			},
		},
		{
			key: 'definitions',
			label: 'Published workflows',
			defaultRetentionDays: null,
			exportable: true,
			export: async ({ tenantId, sink }): Promise<DataClassExportSummary> => {
				let after: WorkflowDefinitionExportCursor | null = null;
				let rows = 0;
				let from: Date | null = null;
				let to: Date | null = null;
				for (;;) {
					const page = await (
						await repository()
					).exportPublishedDefinitionsPage(tenantId, after, pageSize);
					for (const { definition, revision } of page) {
						const at = new Date(definition.updatedAt);
						if (!from || at < from) from = at;
						if (!to || at > to) to = at;
						after = { name: definition.name, id: definition.id };
						rows += 1;
						await sink.write(definitionRow(definition, revision));
					}
					if (page.length < pageSize) return { rows, from, to };
				}
			},
		},
	];
}

/**
 * One run as the archive carries it. The fields are named one by one so a
 * column added to the run later has to be put here deliberately rather than
 * reaching the export because it exists, which is what keeps the payload
 * identifiers and the stored graph out of it.
 */
function runRow(
	run: WorkflowRunRecord,
	nodes: readonly WorkflowNodeExecution[],
	edges: readonly WorkflowEdgeTransfer[],
): Record<string, unknown> {
	return {
		id: run.id,
		tenantId: run.tenantId,
		workflowId: run.workflowId,
		workflowKey: run.workflowKey,
		workflowName: run.workflowName,
		workflowRevision: run.workflowRevision,
		graphChecksum: run.graphChecksum,
		mode: run.mode,
		status: run.status,
		actor: run.actor,
		authorizationSubject: run.authorizationSubject,
		origin: run.origin,
		permissionSnapshot: run.permissionSnapshot,
		permissionDigest: run.permissionDigest,
		inputHash: run.inputHash,
		completedNodes: run.completedNodes,
		totalNodes: run.totalNodes,
		failureCode: run.failureCode,
		usage: run.usage,
		cost: run.cost,
		queuedAt: new Date(run.queuedAt).toISOString(),
		startedAt:
			run.startedAt === null ? null : new Date(run.startedAt).toISOString(),
		completedAt:
			run.completedAt === null ? null : new Date(run.completedAt).toISOString(),
		durationMs: run.durationMs,
		nodes,
		edges,
	};
}

function definitionRow(
	definition: WorkflowDefinition,
	revision: WorkflowRevision,
): Record<string, unknown> {
	return {
		id: definition.id,
		tenantId: definition.tenantId,
		key: definition.key,
		name: definition.name,
		description: definition.description,
		status: definition.status,
		publishedRevision: definition.publishedRevision,
		graph: revision.graph,
		graphChecksum: revision.graphChecksum,
		compiledOrder: revision.compiledOrder,
		publishedBy: revision.publishedBy,
		publishedAt:
			revision.publishedAt === null
				? null
				: new Date(revision.publishedAt).toISOString(),
		createdAt: new Date(definition.createdAt).toISOString(),
		updatedAt: new Date(definition.updatedAt).toISOString(),
	};
}
