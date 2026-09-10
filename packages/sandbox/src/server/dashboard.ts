import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { readDeliveryRecord } from './delivery/record.ts';
import { ownsSession } from './session-owner.ts';
import { hashSpec } from './spec.ts';
import {
	modulePathOf,
	sessionPaths,
	type ChatEntry,
	type SandboxSession,
	type SessionOwner,
} from './sessions.ts';

export type WorkStatus =
	| 'draft'
	| 'working'
	| 'approval'
	| 'approved'
	| 'changes'
	| 'rejected'
	| 'attention'
	| 'review'
	| 'delivered'
	| 'archived';

export interface WorkUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	reportedTurns: number;
	missingUsage: number;
	knownCostUsd: number;
	pricedTurns: number;
	unpricedTurns: number;
}

export interface DashboardRow {
	readonly session: SandboxSession;
	readonly personal: boolean;
	readonly status: WorkStatus;
	readonly usage: WorkUsage;
	readonly approvedModules: number;
	readonly phases: readonly {
		readonly role: string;
		readonly usage: WorkUsage;
	}[];
}

export interface SandboxDashboard {
	readonly rows: readonly DashboardRow[];
	readonly usage: WorkUsage;
	readonly counts: Readonly<Record<WorkStatus, number>>;
	readonly legacySessions: number;
	readonly deletedSessions: number;
}

export function emptyUsage(): WorkUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		reportedTurns: 0,
		missingUsage: 0,
		knownCostUsd: 0,
		pricedTurns: 0,
		unpricedTurns: 0,
	};
}

export function addUsage(target: WorkUsage, source: WorkUsage): void {
	for (const key of Object.keys(target) as (keyof WorkUsage)[])
		target[key] += source[key];
}

/* A streaming projection, not another billing ledger. Keep only counters and
   the latest decision, never prompts or tool output. Monotonic sequence ids
   make duplicate transcript lines harmless without an unbounded id set. */
export async function summarizeTranscript(
	entries: AsyncIterable<ChatEntry> | Iterable<ChatEntry>,
) {
	const usage = emptyUsage();
	const phases = new Map<string, WorkUsage>();
	const decisions = new Map<string, ChatEntry['decision']>();
	let sequence = 0;
	let pending: WorkUsage | null = null;
	for await (const entry of entries) {
		if (entry.sequence <= sequence) continue;
		sequence = entry.sequence;
		if (entry.decision && entry.module)
			decisions.set(entry.module, entry.decision);
		const event = entry.event;
		if (event?.type !== 'turn.started' && event?.type !== 'turn.completed')
			continue;
		const role = entry.role || 'unknown';
		let phase = phases.get(role);
		if (!phase) {
			phase = emptyUsage();
			phases.set(role, phase);
		}
		if (event.type === 'turn.started') {
			if (pending) {
				pending.missingUsage++;
				pending.unpricedTurns++;
			}
			pending = phase;
			continue;
		}
		pending = null;
		const values = [
			event.usage?.inputTokens,
			event.usage?.outputTokens,
			event.usage?.totalTokens,
		];
		const valid =
			values.every((value) => Number.isSafeInteger(value) && value >= 0) &&
			(event.finishReason === 'stop' || values.some((value) => value > 0));
		if (valid) {
			phase.inputTokens += event.usage.inputTokens;
			phase.outputTokens += event.usage.outputTokens;
			phase.totalTokens += event.usage.totalTokens;
			phase.reportedTurns++;
		} else phase.missingUsage++;
		if (
			typeof event.costUsd === 'number' &&
			Number.isFinite(event.costUsd) &&
			event.costUsd >= 0
		) {
			phase.knownCostUsd += event.costUsd;
			phase.pricedTurns++;
		} else phase.unpricedTurns++;
	}
	if (pending) {
		pending.missingUsage++;
		pending.unpricedTurns++;
	}
	for (const phase of phases.values()) addUsage(usage, phase);
	return {
		usage,
		phases: [...phases].map(([role, usage]) => ({ role, usage })),
		decisions,
	};
}

async function* transcript(path: string): AsyncIterable<ChatEntry> {
	const stream = createReadStream(path, { encoding: 'utf8' });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			if (!line.trim()) continue;
			try {
				yield JSON.parse(line) as ChatEntry;
			} catch {
				throw new Error(
					'The session history is incomplete. Reload the dashboard.',
				);
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	} finally {
		lines.close();
		stream.destroy();
	}
}

export async function buildDashboard(
	root: string,
	sessions: readonly SandboxSession[],
	owner: SessionOwner | null,
	running: ReadonlySet<string>,
): Promise<SandboxDashboard> {
	const usage = emptyUsage();
	const rows: DashboardRow[] = [];
	const counts: Record<WorkStatus, number> = {
		draft: 0,
		working: 0,
		approval: 0,
		approved: 0,
		changes: 0,
		rejected: 0,
		attention: 0,
		review: 0,
		delivered: 0,
		archived: 0,
	};
	let legacySessions = 0;
	let deletedSessions = 0;
	for (const session of sessions) {
		const personal = ownsSession(session, owner);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		const summary = await summarizeTranscript(transcript(paths.chatLog));
		if (personal) addUsage(usage, summary.usage);
		else legacySessions++;
		if (session.state === 'deleted') {
			if (personal) deletedSessions++;
			continue;
		}
		let approvedModules = 0;
		for (const module of session.modules) {
			if (!module.specHash || !module.specApprovedAt) continue;
			const spec = await readFile(
				join(modulePathOf(paths, module.directory), 'spec/module.yaml'),
				'utf8',
			).catch(() => null);
			if (spec && hashSpec(spec) === module.specHash) approvedModules++;
		}
		const delivery = session.ejectedAt
			? await readDeliveryRecord(paths.root)
			: null;
		const status: WorkStatus = session.rejectedAt
			? 'rejected'
			: session.archivedAt
				? 'archived'
				: session.ejectedAt
					? delivery?.target === 'workspace'
						? 'delivered'
						: 'review'
					: running.has(session.id)
						? 'working'
						: session.state === 'failed' || session.state === 'blocked'
							? 'attention'
							: session.state === 'awaiting-approval'
								? 'approval'
								: approvedModules === session.modules.length &&
									  approvedModules > 0
									? 'approved'
									: [...summary.decisions.values()].includes(
												'changes-requested',
										  )
										? 'changes'
										: 'draft';
		if (personal) counts[status]++;
		rows.push({
			session,
			personal,
			status,
			usage: summary.usage,
			phases: summary.phases,
			approvedModules,
		});
	}
	return { rows, usage, counts, legacySessions, deletedSessions };
}
