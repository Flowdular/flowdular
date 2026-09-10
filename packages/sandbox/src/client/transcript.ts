import type { ChatEntry } from '../server/sessions.ts';

export interface TranscriptRow {
	readonly key: number;
	entry: ChatEntry;
	started?: ChatEntry;
	pending: boolean;
}

/* Pair calls by provider identity, including parallel calls to the same file.
   Old transcripts without ids are paired only with one unambiguous pending call.
   This is presentation only: persisted events and their full details stay intact. */
export function transcriptRows(entries: readonly ChatEntry[]): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	const calls = new Map<string, TranscriptRow>();
	const pending = new Set<TranscriptRow>();
	const closeTurn = () => {
		for (const row of pending) row.pending = false;
		pending.clear();
		calls.clear();
	};
	for (const entry of entries) {
		const event = entry.event;
		if (
			entry.kind === 'user' ||
			entry.handoff ||
			event?.type === 'turn.started' ||
			event?.type === 'turn.completed'
		)
			closeTurn();
		if (event?.type === 'reasoning' && !event.text.trim()) continue;
		if (event?.type === 'tool.completed') {
			let start = event.callId ? calls.get(event.callId) : undefined;
			if (!event.callId && pending.size === 1) {
				const candidate = pending.values().next().value!;
				const original = candidate.entry.event;
				if (
					original?.type === 'tool.started' &&
					!original.callId &&
					(event.tool === original.tool || event.tool === 'tool') &&
					(!event.detail || event.detail === original.detail)
				)
					start = candidate;
			}
			if (
				start &&
				start.entry.role === entry.role &&
				start.entry.module === entry.module
			) {
				start.started = start.entry;
				start.entry = entry;
				start.pending = false;
				pending.delete(start);
				if (event.callId) calls.delete(event.callId);
				continue;
			}
		}
		const row: TranscriptRow = {
			key: entry.sequence,
			entry,
			pending: event?.type === 'tool.started',
		};
		rows.push(row);
		if (event?.type === 'tool.started') {
			pending.add(row);
			if (event.callId) calls.set(event.callId, row);
		}
	}
	return rows;
}

export function shortToolDetail(detail: string): string {
	if (!/^(?:\/|[A-Za-z]:[\\/]|modules[\\/])/.test(detail)) return detail;
	return detail
		.replaceAll('\\', '/')
		.replace(
			/^.*?\/(?:\.flowdular|\.coreloom)\/sandbox\/sessions\/[^/]+\/workspace\//,
			'',
		)
		.replace(/^modules\//, '');
}

export function toolAction(name: string): string {
	switch (name.toLowerCase()) {
		case 'read':
		case 'read_file':
			return 'read';
		case 'edit':
		case 'multiedit':
		case 'update':
			return 'edit';
		case 'write':
		case 'write_file':
		case 'create':
			return 'write';
		case 'delete_file':
		case 'delete':
			return 'delete';
		case 'glob':
		case 'list_files':
			return 'list';
		case 'grep':
			return 'search';
		case 'bash':
		case 'command':
			return 'command';
		default:
			return 'tool';
	}
}
