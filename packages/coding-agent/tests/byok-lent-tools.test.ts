import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createByokDriver } from '../src/drivers/byok.ts';
import type { CodingAgentEvent, CodingAgentTool } from '../src/types.ts';

const offered = vi.hoisted(() => ({
	names: [] as string[],
	answer: null as unknown,
}));

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
			offered.names = Object.keys(tools).sort();
			offered.answer = await tools['sample-data']!.execute({
				name: 'rooms.csv',
			});
			yield { type: 'text-delta', text: 'Done.' };
		})(),
	}),
}));

it('offers a lent read-only tool beside the file tools without replacing one', async () => {
	const root = await mkdtemp(join(tmpdir(), 'byok-lent-'));
	const calls: unknown[] = [];
	const lend = (name: string): CodingAgentTool => ({
		name,
		description: `Lent ${name}.`,
		inputSchema: {
			type: 'object',
			properties: { name: { type: 'string' } },
			additionalProperties: false,
		},
		execute: async (input) => {
			calls.push([name, input]);
			return `answered ${String(input.name)}`;
		},
	});
	try {
		const driver = createByokDriver({
			configuration: { kind: 'openai', model: 'test', credential: 'fixture' },
		});
		const events: CodingAgentEvent[] = [];
		for await (const event of driver.run({
			workspacePath: root,
			allowedPaths: [],
			role: 'backend-engineer',
			systemInstruction: 'Test',
			prompt: 'Test',
			tools: [lend('sample-data'), lend('read_file')],
		}))
			events.push(event);

		expect(offered.names).toEqual([
			'delete_file',
			'list_files',
			'read_file',
			'sample-data',
			'write_file',
		]);
		expect(offered.answer).toBe('answered rooms.csv');
		expect(calls).toEqual([['sample-data', { name: 'rooms.csv' }]]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'tool.completed',
				tool: 'sample-data',
				ok: true,
			}),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
