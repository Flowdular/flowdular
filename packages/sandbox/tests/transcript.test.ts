import { describe, expect, it } from 'vitest';
import type { CodingAgentEvent } from '@flowdular/coding-agent';
import type { ChatEntry } from '../src/server/sessions.ts';
import {
	shortToolDetail,
	toolAction,
	transcriptRows,
} from '../src/client/transcript.ts';

const entry = (sequence: number, event: CodingAgentEvent): ChatEntry => ({
	sequence,
	at: sequence * 1000,
	kind: 'event',
	role: 'backend-engineer',
	event,
});
const start = (sequence: number, callId?: string) =>
	entry(sequence, {
		type: 'tool.started',
		tool: 'Edit',
		detail:
			'/app/.flowdular/sandbox/sessions/id/workspace/modules/blog/src/api.ts',
		...(callId ? { callId } : {}),
	});
const done = (sequence: number, callId?: string, ok = true) =>
	entry(sequence, {
		type: 'tool.completed',
		tool: 'tool',
		detail: '',
		ok,
		...(callId ? { callId } : {}),
	});

describe('transcript operations', () => {
	it('retains the complete history and pairs parallel calls in start order', () => {
		const inputs = Array.from({ length: 12 }, (_, i) =>
			start(i + 1, String(i)),
		);
		const completions = Array.from({ length: 12 }, (_, i) =>
			done(i + 13, String(11 - i), i !== 0),
		);
		const rows = transcriptRows([...inputs, ...completions]);
		expect(rows).toHaveLength(12);
		expect(rows.map((row) => row.key)).toEqual(inputs.map((e) => e.sequence));
		expect(rows[0]?.entry.sequence).toBe(24);
		expect(rows[11]?.entry.event).toMatchObject({ ok: false });
		expect(rows.every((row) => !row.pending && row.started)).toBe(true);
		expect(inputs[0]?.event?.type).toBe('tool.started');
	});
	it('pairs a legacy call only when it is unambiguous', () => {
		expect(transcriptRows([start(1), done(2)])).toHaveLength(1);
		expect(transcriptRows([start(1), start(2), done(3)])).toHaveLength(3);
		expect(transcriptRows([start(1, 'a'), done(2, 'b')])).toHaveLength(2);
	});
	it('never pairs across turns and leaves interrupted work uncompleted', () => {
		const user: ChatEntry = {
			sequence: 2,
			at: 2000,
			kind: 'user',
			role: 'operator',
			text: 'Continue',
		};
		const rows = transcriptRows([
			start(1, 'a'),
			user,
			done(3, 'a'),
			start(4, 'b'),
		]);
		expect(rows).toHaveLength(4);
		expect(rows[0]?.pending).toBe(false);
		expect(rows[0]?.entry.event?.type).toBe('tool.started');
		expect(rows[3]?.pending).toBe(true);
	});
	it('does not merge a completion into another role or module', () => {
		expect(
			transcriptRows([
				start(1, 'a'),
				{ ...done(2, 'a'), role: 'frontend-engineer' },
			]),
		).toHaveLength(2);
		expect(
			transcriptRows([start(1, 'a'), { ...done(2, 'a'), module: 'other' }]),
		).toHaveLength(2);
	});
	it('shows the useful module path while preserving other targets and tool names', () => {
		expect(
			shortToolDetail(
				'/Users/me/blog/.flowdular/sandbox/sessions/id/workspace/modules/blog/src/api.ts',
			),
		).toBe('blog/src/api.ts');
		expect(
			shortToolDetail(
				'C:\\app\\.coreloom\\sandbox\\sessions\\id\\workspace\\reference\\guide.md',
			),
		).toBe('reference/guide.md');
		expect(shortToolDetail('pnpm test')).toBe('pnpm test');
		expect(shortToolDetail('echo \\n')).toBe('echo \\n');
		expect(shortToolDetail('/tmp/external.ts')).toBe('/tmp/external.ts');
		expect(toolAction('Edit')).toBe('edit');
		expect(toolAction('read_file')).toBe('read');
		expect(toolAction('unknown')).toBe('tool');
	});
});
