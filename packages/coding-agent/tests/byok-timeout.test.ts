import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createByokDriver } from '../src/drivers/byok.ts';
import type { CodingAgentEvent } from '../src/types.ts';

vi.mock('@flowdular/ai-provider', async (original) => ({
	...(await original<typeof import('@flowdular/ai-provider')>()),
	resolveLanguageModel: () => ({}),
}));
/* A provider that never answers. Like the SDK, the stream ends quietly with an
   abort part once its signal fires, and answers at once when it has none. */
vi.mock('ai', async (original) => ({
	...(await original<typeof import('ai')>()),
	streamText: ({ abortSignal }: { abortSignal?: AbortSignal }) => ({
		fullStream: (async function* () {
			if (!abortSignal) {
				yield { type: 'text-delta', text: 'Done.' };
				return;
			}
			if (!abortSignal.aborted) {
				await new Promise((resolve) =>
					abortSignal.addEventListener('abort', resolve, { once: true }),
				);
			}
			yield { type: 'abort' };
		})(),
	}),
}));

async function run(
	request: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CodingAgentEvent[]> {
	const root = await mkdtemp(join(tmpdir(), 'byok-timeout-'));
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
			...request,
		}))
			events.push(event);
		return events;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

it('stops a BYOK turn at the limit the request sets and names that limit', async () => {
	const events = await run({ timeoutMs: 50 });
	expect(events.find((event) => event.type === 'error')).toMatchObject({
		code: 'DRIVER_TIMEOUT',
		message: expect.stringContaining('turn time limit of 50 milliseconds'),
	});
	expect(events.at(-1)).toMatchObject({
		type: 'turn.completed',
		finishReason: 'error',
	});
});

it('does not report an operator stop as a time limit', async () => {
	const controller = new AbortController();
	setTimeout(() => controller.abort('stopped'), 20);
	const events = await run({ timeoutMs: 60_000, signal: controller.signal });
	expect(events.some((event) => event.type === 'error')).toBe(false);
	expect(events.at(-1)).toMatchObject({
		type: 'turn.completed',
		finishReason: 'aborted',
	});
});

it('reports an operator stop without a time limit as aborted', async () => {
	const controller = new AbortController();
	setTimeout(() => controller.abort('stopped'), 20);
	const events = await run({ signal: controller.signal });
	expect(events.some((event) => event.type === 'error')).toBe(false);
	expect(events.at(-1)).toMatchObject({
		type: 'turn.completed',
		finishReason: 'aborted',
	});
});
