import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createByokDriver } from '../src/drivers/byok.ts';
import type { CodingAgentEvent } from '../src/types.ts';

vi.mock('@flowdular/ai-provider', async (original) => ({
	...(await original<typeof import('@flowdular/ai-provider')>()),
	resolveLanguageModel: () => ({}),
}));
vi.mock('ai', async (original) => ({
	...(await original<typeof import('ai')>()),
	streamText: ({
		tools,
	}: {
		tools: Record<string, { execute: (input: unknown) => Promise<unknown> }>;
	}) => ({
		fullStream: (async function* () {
			await Promise.all([
				tools.write_file!.execute({ path: 'src/ok.ts', content: 'export {};' }),
				tools.read_file!.execute({ path: 'missing.ts' }),
			]);
			yield { type: 'text-delta', text: 'Done.' };
		})(),
	}),
}));

it('pairs parallel BYOK success and failure events with distinct call identities', async () => {
	const root = await mkdtemp(join(tmpdir(), 'byok-events-'));
	try {
		const driver = createByokDriver({
			configuration: { kind: 'openai', model: 'test', credential: 'fixture' },
		});
		const events: CodingAgentEvent[] = [];
		for await (const event of driver.run({
			workspacePath: root,
			allowedPaths: ['src/**'],
			role: 'backend-engineer',
			systemInstruction: 'Test',
			prompt: 'Test',
		}))
			events.push(event);
		const starts = events.filter((e) => e.type === 'tool.started');
		const ends = events.filter((e) => e.type === 'tool.completed');
		expect(starts).toHaveLength(2);
		expect(new Set(starts.map((e) => e.callId)).size).toBe(2);
		for (const start of starts) {
			expect(start.callId).toBeTruthy();
			expect(ends.find((e) => e.callId === start.callId)).toMatchObject({
				tool: start.tool,
				ok: start.tool === 'write_file',
			});
		}
		expect(await readFile(join(root, 'src/ok.ts'), 'utf8')).toBe('export {};');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
