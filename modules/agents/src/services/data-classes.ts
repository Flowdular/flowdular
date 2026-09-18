import type {
	DataClassDeclaration,
	DataClassExportSummary,
} from '@flowdular/kernel';
import type { AgentExecutionEvent } from '@flowdular/harness';
import type {
	AgentRun,
	AssistantThread,
	AssistantTurn,
} from '../domain/types.ts';
import type {
	AgentRunExportCursor,
	AgentRepository,
	AssistantThreadExportCursor,
} from './repository.ts';

/** Rows one keyset page carries. Bounded so a walk never loads a whole table. */
export const EXPORT_PAGE = 500;

/**
 * Days a run and its steps are kept, per D-AUDIT-RETENTION-DEFAULTS. A run is
 * the record of what an agent did with a workspace's data, so it ages out;
 * the cost rollup a run wrote is a child of the run and leaves with it.
 */
export const RUN_RETENTION_DAYS = 90;

/**
 * The classes agents.core owns.
 *
 * `runs` is what a workspace accumulates: the run record, its steps, and the
 * child rows that hang off it. Only a settled run is swept, so a queued or
 * running one is never taken out from under its worker, and the export walks
 * the run order the queue index already carries.
 *
 * `audit-events` carries no sweep. The trail is hash chained per workspace,
 * every event naming the hash of the one before it, and verifyAuditChain walks
 * it from sequence 1 with no previous hash. Deleting the oldest events by age
 * would leave the first surviving event pointing at a row that is gone, so the
 * next verification would report the chain broken and could not tell retention
 * from tampering. automations.core and audit.core keep their chained ledgers
 * for the same reason. The precise fix is chain archival, sealing a removed
 * prefix under one anchor event; until that exists these rows are kept until a
 * person deletes them.
 *
 * `provider-credentials` is the workspace's configuration rather than history:
 * it is never swept, and it is excluded from the export because the row exists
 * to hold a sealed provider secret. Everything a person may see about a
 * connection is already on the providers screen.
 *
 * The repository arrives as a thunk because declaring happens while the
 * platform composes, before anything has opened a database.
 */
export function agentsDataClasses(
	repository: () => Promise<AgentRepository>,
	pageSize = EXPORT_PAGE,
): readonly DataClassDeclaration[] {
	return [
		{
			key: 'runs',
			label: 'Agent runs',
			defaultRetentionDays: RUN_RETENTION_DAYS,
			exportable: true,
			sweep: async ({ tenantId, cutoff, limit }) => ({
				removed: await (
					await repository()
				).deleteSettledRunsBefore(tenantId, cutoff.getTime(), limit),
			}),
			/* The runs one account requested, in any state. A run this removes
			   while a worker holds it is the lost-lease case that worker already
			   handles, so an erasure never waits for the queue to drain. */
			erase: async ({ tenantId, subject, limit }) => {
				const removed = await (
					await repository()
				).deleteRunsRequestedBy(tenantId, subject.accountId, limit);
				/* A full batch may have left more behind; the caller repeats and
				   the next batch answers zero. Over-reporting one repeat is
				   cheaper than reporting a subject as cleared while rows remain. */
				return removed === limit ? { removed, truncated: true } : { removed };
			},
			export: async ({ tenantId, sink }): Promise<DataClassExportSummary> => {
				let after: AgentRunExportCursor | null = null;
				let rows = 0;
				let from: Date | null = null;
				let to: Date | null = null;
				for (;;) {
					const page = await (
						await repository()
					).exportRunsPage(tenantId, after, pageSize);
					for (const { run, events } of page) {
						const at = new Date(run.queuedAt);
						if (!from || at < from) from = at;
						if (!to || at > to) to = at;
						after = { queuedAt: run.queuedAt, id: run.id };
						rows += 1;
						await sink.write(runRow(run, events));
					}
					if (page.length < pageSize) return { rows, from, to };
				}
			},
		},
		{
			key: 'audit-events',
			label: 'Agent audit trail',
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
			key: 'assistant-threads',
			label: 'Assistant conversations',
			/* A conversation is the member's own record of what they asked, not
			   history of a run, so no sweep takes it: the member deletes their own
			   thread and an erasure takes the threads of the account whose runs it
			   removes. */
			defaultRetentionDays: null,
			exportable: true,
			erase: async ({ tenantId, subject, limit }) => {
				const removed = await (
					await repository()
				).deleteAssistantThreadsOf(tenantId, subject.accountId, limit);
				return removed === limit ? { removed, truncated: true } : { removed };
			},
			export: async ({ tenantId, sink }): Promise<DataClassExportSummary> => {
				let after: AssistantThreadExportCursor | null = null;
				let rows = 0;
				let from: Date | null = null;
				let to: Date | null = null;
				for (;;) {
					const page = await (
						await repository()
					).exportAssistantThreadsPage(tenantId, after, pageSize);
					for (const { thread, turns } of page) {
						const at = new Date(thread.createdAt);
						if (!from || at < from) from = at;
						if (!to || at > to) to = at;
						after = { updatedAt: thread.updatedAt, id: thread.id };
						rows += 1;
						await sink.write(threadRow(thread, turns));
					}
					if (page.length < pageSize) return { rows, from, to };
				}
			},
		},
		{
			key: 'provider-credentials',
			label: 'Provider connections',
			defaultRetentionDays: null,
			exportable: false,
			excludedReason:
				'A provider connection holds an encrypted provider credential; the workspace reads its safe metadata on the providers screen instead.',
		},
	];
}

/** One conversation as the archive carries it, questions and answers included. */
function threadRow(
	thread: AssistantThread,
	turns: readonly AssistantTurn[],
): Record<string, unknown> {
	return {
		id: thread.id,
		tenantId: thread.tenantId,
		accountId: thread.accountId,
		title: thread.title,
		turnCount: thread.turnCount,
		createdAt: new Date(thread.createdAt).toISOString(),
		updatedAt: new Date(thread.updatedAt).toISOString(),
		turns: turns.map((turn) => ({
			id: turn.id,
			sequence: turn.sequence,
			question: turn.question,
			answer: turn.answer,
			runId: turn.runId,
			status: turn.status,
			failureCode: turn.failureCode,
			createdAt: new Date(turn.createdAt).toISOString(),
			updatedAt: new Date(turn.updatedAt).toISOString(),
		})),
	};
}

/**
 * One run as the archive carries it. The fields are named one by one so a
 * column added to the run later has to be put here deliberately rather than
 * reaching the export because it exists.
 */
function runRow(
	run: AgentRun,
	events: readonly AgentExecutionEvent[],
): Record<string, unknown> {
	return {
		id: run.id,
		tenantId: run.tenantId,
		agentId: run.agentId,
		agentName: run.agentName,
		agentRevision: run.agentRevision,
		trigger: run.trigger,
		status: run.status,
		input: run.input,
		output: run.output,
		structuredOutput: run.structuredOutput,
		outputContract: run.outputContract,
		workflowRunId: run.workflowRunId,
		provider: run.provider,
		model: run.model,
		requestedBy: run.requestedBy,
		requestedActor: run.requestedActor,
		authorizationSubject: run.authorizationSubject,
		permissionSnapshot: run.permissionSnapshot,
		toolGrants: run.toolGrants,
		usage: run.usage,
		failureCode: run.failureCode,
		failureMessage: run.failureMessage,
		attempt: run.attempt,
		queuedAt: new Date(run.queuedAt).toISOString(),
		startedAt:
			run.startedAt === null ? null : new Date(run.startedAt).toISOString(),
		completedAt:
			run.completedAt === null ? null : new Date(run.completedAt).toISOString(),
		steps: events.map((event) => ({
			sequence: event.sequence,
			type: event.type,
			message: event.message,
			metadata: event.metadata,
			occurredAt: new Date(event.timestamp).toISOString(),
		})),
	};
}
