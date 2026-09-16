import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { userActor } from '@flowdular/kernel';
import {
	AgentHarness,
	type AgentExecutionRequest,
	type AgentProvider,
	type AgentProviderContext,
} from '@flowdular/harness';
import { DOCUMENTS_PERMISSIONS } from '../src/acl/permissions.ts';
import {
	documentsAgentTools,
	DOCUMENTS_RENDER_TOOL,
} from '../src/agent/tools.ts';
import { createDocumentsRuntime } from '../src/server/runtime.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import { OFFER_KEY, offerDefinition, offerInput } from './support/templates.ts';

const TENANT = 'tenant-render-agents';
const GRANTED = [
	DOCUMENTS_PERMISSIONS.templatesRead,
	DOCUMENTS_PERMISSIONS.manage,
];

let context: DocumentsTestContext;

beforeAll(async () => {
	context = await openDocumentsTestContext({ maxObjectBytes: 4 * 1024 * 1024 });
});

afterAll(async () => {
	await context?.dispose();
});

afterEach(async () => {
	await context.reset();
});

function runtime() {
	const documents = createDocumentsRuntime({
		databases: context.databases,
		purpose: 'test',
		repository: context.repository,
		templatesRepository: context.templates,
		storage: context.storage.port,
		quotaBytes: () => 10 * 1024 * 1024,
		readUrlSeconds: () => 300,
	});
	documents.templates.register('orders.core', [offerDefinition()]);
	return documents;
}

function request(
	runId: string,
	permissions: readonly string[],
): AgentExecutionRequest {
	return {
		runId,
		tenantId: TENANT,
		requestedBy: 'account-ada',
		requestedActor: userActor({
			accountId: 'account-ada',
			displayName: 'Ada',
			email: 'ada@example.com',
		}),
		trigger: 'playground',
		input: 'Prepare the offer.',
		definition: {
			id: 'agent-writer',
			name: 'Writer',
			revision: 1,
			instructions: 'Render the offer for the order.',
			provider: 'scripted',
			model: 'deterministic-v1',
			allowedTools: [DOCUMENTS_RENDER_TOOL],
			maxSteps: 4,
			timeoutMs: 10_000,
			temperature: 0,
		},
		permissionSnapshot: [...permissions],
		toolGrants: [DOCUMENTS_RENDER_TOOL],
	};
}

/* One run calls the tool once per input, in order, as a model retrying or
   repeating a call would. */
async function run(
	runId: string,
	permissions: readonly string[],
	inputs: readonly Record<string, unknown>[],
): Promise<{ outcomes: unknown[]; denied: unknown }> {
	const documents = runtime();
	const harness = new AgentHarness({
		providers: [],
		tools: documentsAgentTools(documents),
		authorizeToolAccess: () => [...permissions],
	});
	const outcomes: unknown[] = [];
	const provider: AgentProvider = {
		id: 'scripted',
		execute: async (providerContext: AgentProviderContext) => {
			for (const input of inputs) {
				try {
					outcomes.push(
						await providerContext.invokeTool(DOCUMENTS_RENDER_TOOL, input),
					);
				} catch (error) {
					const failure = error as { code?: string; message?: string };
					outcomes.push({ code: failure.code, message: failure.message });
				}
			}
			return {
				output: 'done',
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				finishReason: 'stop',
			};
		},
	};
	const result = await harness.execute(request(runId, permissions), {
		provider,
	});
	await documents.dispose();
	return {
		outcomes,
		denied: result.events.find((event) => event.type === 'tool.denied')
			?.metadata,
	};
}

function renderInput(rows: number) {
	return {
		templateKey: OFFER_KEY,
		ownerModule: 'orders.core',
		recordRef: 'order-9',
		input: offerInput(rows),
	};
}

describe('documents.render agent tool', () => {
	it('DOCUMENTS-RENDER-TOOL answers the same render for a repeated call and a new document for another input', async () => {
		const first = await run('run-a', GRANTED, [
			renderInput(2),
			renderInput(2),
			renderInput(3),
		]);
		const [once, twice, other] = first.outcomes as {
			jobId: string;
			documentId: string;
			status: string;
			version: number;
		}[];
		expect(once).toMatchObject({
			status: 'succeeded',
			templateKey: OFFER_KEY,
			version: 1,
			format: 'pdf',
		});
		expect(twice).toEqual(once);
		expect(other!.documentId).not.toBe(once!.documentId);
		const retried = await run('run-b', GRANTED, [renderInput(2)]);
		expect(retried.outcomes).toEqual([once]);
		const attached = await context
			.service()
			.listAttached(TENANT, 'orders.core', 'order-9');
		expect(attached.map((document) => document.id).sort()).toEqual(
			[once!.documentId, other!.documentId].sort(),
		);
	});

	it('DOCUMENTS-RENDER-TOOL is denied by the harness to a run without documents.files.manage', async () => {
		const { outcomes, denied } = await run(
			'run-c',
			[DOCUMENTS_PERMISSIONS.templatesRead],
			[renderInput(2)],
		);
		expect(denied).toMatchObject({ tool: DOCUMENTS_RENDER_TOOL });
		expect(outcomes).toEqual([
			expect.objectContaining({ code: expect.any(String) }),
		]);
		expect(await context.templates.listTemplates(TENANT, 10)).toEqual([]);
	});
});

describe('documents.render key ledger', () => {
	function toolContext(key: string | undefined) {
		return {
			runId: 'run-direct',
			tenantId: TENANT,
			requestedBy: 'account-ada',
			permissions: new Set<string>(GRANTED),
			signal: new AbortController().signal,
			...(key === undefined ? {} : { idempotencyKey: key }),
		};
	}

	it('DOCUMENTS-RENDER-TOOL answers a retried call from its key after the template gained a version, and reads status by job', async () => {
		const documents = runtime();
		const [, render, status] = documentsAgentTools(documents);
		const first = (await render!.execute(
			renderInput(2),
			toolContext('harness-key-0001'),
		)) as { jobId: string; documentId: string; version: number };
		expect(first.version).toBe(1);
		const templates = await documents.templatesService();
		/* Version 2 cannot print this input, so only the key can answer the
		   retry without evaluating it again. */
		await templates.save(TENANT, 'account-ada', {
			key: OFFER_KEY,
			body: "{{#each items}}\n{{ price | money: 'XYZ' }}\n{{/each}}",
			layout: {},
			expectedVersion: 1,
		});
		expect(
			await render!.execute(renderInput(2), toolContext('harness-key-0001')),
		).toEqual(first);
		expect(
			await context.templates.exportRenders(TENANT, null, 10),
		).toHaveLength(1);
		await templates.save(TENANT, 'account-ada', {
			key: OFFER_KEY,
			body: '# Nowa wersja {{ customer }}',
			layout: {},
			expectedVersion: 2,
		});
		const fresh = (await render!.execute(
			renderInput(2),
			toolContext('harness-key-0002'),
		)) as { jobId: string; version: number };
		expect([fresh.version, fresh.jobId === first.jobId]).toEqual([3, false]);
		await expect(
			render!.execute(renderInput(3), toolContext('harness-key-0001')),
		).rejects.toMatchObject({ code: 'TEMPLATE_RENDER_KEY_REUSED' });
		expect(
			await status!.execute({ jobId: first.jobId }, toolContext(undefined)),
		).toEqual(first);
		await expect(
			status!.execute({ jobId: 'missing' }, toolContext(undefined)),
		).rejects.toMatchObject({ code: 'TEMPLATE_RENDER_NOT_FOUND' });
		await documents.dispose();
	});
});
