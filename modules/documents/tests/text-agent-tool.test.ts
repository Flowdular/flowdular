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
	DOCUMENTS_READ_TEXT_TOOL,
} from '../src/agent/tools.ts';
import { DOCUMENT_TEXT_LIMITS } from '../src/domain/text.ts';
import { createDocumentsRuntime } from '../src/server/runtime.ts';
import {
	openDocumentsTestContext,
	type DocumentsTestContext,
} from './support/database.ts';
import { pdfDocument } from './support/text-fixtures.ts';

const TENANT = 'tenant-agents';
const OWNER = 'directory.core';
const RECORD = 'party-4711';

let context: DocumentsTestContext;

beforeAll(async () => {
	context = await openDocumentsTestContext({ maxObjectBytes: 64 * 1024 });
});

afterAll(async () => {
	await context?.dispose();
});

afterEach(async () => {
	await context.reset();
});

function runtime() {
	return createDocumentsRuntime({
		databases: context.databases,
		purpose: 'test',
		repository: context.repository,
		storage: context.storage.port,
		quotaBytes: () => 10 * 1024 * 1024,
		readUrlSeconds: () => 300,
	});
}

function request(permissions: readonly string[]): AgentExecutionRequest {
	return {
		runId: 'run-documents',
		tenantId: TENANT,
		requestedBy: 'account-ada',
		requestedActor: userActor({
			accountId: 'account-ada',
			displayName: 'Ada',
			email: 'ada@example.com',
		}),
		trigger: 'playground',
		input: 'Read the policy.',
		definition: {
			id: 'agent-reader',
			name: 'Reader',
			revision: 1,
			instructions: 'Read the attached policy.',
			provider: 'scripted',
			model: 'deterministic-v1',
			allowedTools: [DOCUMENTS_READ_TEXT_TOOL],
			maxSteps: 4,
			timeoutMs: 5_000,
			temperature: 0,
		},
		permissionSnapshot: [...permissions],
		toolGrants: [DOCUMENTS_READ_TEXT_TOOL],
	};
}

function scripted(
	script: (context: AgentProviderContext) => Promise<void>,
): AgentProvider {
	return {
		id: 'scripted',
		execute: async (providerContext) => {
			await script(providerContext);
			return {
				output: 'done',
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				finishReason: 'stop',
			};
		},
	};
}

async function call(
	permissions: readonly string[],
	input: Record<string, unknown>,
): Promise<{ outcome: unknown; denied: unknown }> {
	const documents = runtime();
	const harness = new AgentHarness({
		providers: [],
		tools: documentsAgentTools(documents),
		authorizeToolAccess: () => [...permissions],
	});
	let outcome: unknown;
	const run = await harness.execute(request(permissions), {
		provider: scripted(async (providerContext) => {
			try {
				outcome = await providerContext.invokeTool(
					DOCUMENTS_READ_TEXT_TOOL,
					input,
				);
			} catch (error) {
				const failure = error as { code?: string; message?: string };
				outcome = { code: failure.code, message: failure.message };
			}
		}),
	});
	await documents.dispose();
	return {
		outcome,
		denied: run.events.find((event) => event.type === 'tool.denied')?.metadata,
	};
}

describe('documents.read-text agent tool', () => {
	it('DOCUMENTS-TEXT-TOOL answers a page range of a record document under the run workspace', async () => {
		const pdf = await context.service().upload(TENANT, 'account-ada', {
			ownerModule: OWNER,
			recordRef: RECORD,
			filename: 'policy.pdf',
			contentType: 'application/pdf',
			body: pdfDocument(['Cover', 'Terms', 'Signatures']),
		});

		const { outcome } = await call([DOCUMENTS_PERMISSIONS.read], {
			ownerModule: OWNER,
			recordRef: RECORD,
			documentId: pdf.id,
			pages: { from: 2, to: 3 },
		});
		expect(outcome).toEqual({
			documentId: pdf.id,
			status: 'ok',
			reason: null,
			pages: 3,
			from: 2,
			to: 3,
			truncated: false,
			contentSha256: pdf.checksum!.slice('sha256:'.length),
			text: 'Terms\fSignatures',
		});

		const foreign = await call([DOCUMENTS_PERMISSIONS.read], {
			ownerModule: 'users.core',
			recordRef: RECORD,
			documentId: pdf.id,
		});
		/* The harness reports every error a tool throws as a failed execution
		   carrying the tool's own message. */
		expect(foreign.outcome).toEqual({
			code: 'TOOL_EXECUTION_FAILED',
			message: 'No readable document has that id on that record.',
		});
	});

	it('DOCUMENTS-TEXT-TOOL cuts the text to the tool bound at a character and says so', async () => {
		const long = 'Zażółć '.repeat(4_000);
		const pdf = await context.service().upload(TENANT, 'account-ada', {
			ownerModule: OWNER,
			recordRef: RECORD,
			filename: 'long.txt',
			contentType: 'text/plain',
			body: new TextEncoder().encode(long),
		});
		const { outcome } = await call([DOCUMENTS_PERMISSIONS.read], {
			ownerModule: OWNER,
			recordRef: RECORD,
			documentId: pdf.id,
		});
		const answer = outcome as { text: string; truncated: boolean };
		expect(answer.truncated).toBe(true);
		expect(Buffer.byteLength(answer.text, 'utf8')).toBeLessThanOrEqual(
			DOCUMENT_TEXT_LIMITS.toolTextBytes,
		);
		expect(Buffer.byteLength(answer.text, 'utf8')).toBeGreaterThan(
			DOCUMENT_TEXT_LIMITS.toolTextBytes - 4,
		);
		expect(answer.text.startsWith('Zażółć Zażółć')).toBe(true);
		expect(answer.text).not.toContain(String.fromCharCode(0xfffd));
	});

	it('DOCUMENTS-TEXT-TOOL is denied by the harness to a run without documents.files.read', async () => {
		const pdf = await context.service().upload(TENANT, 'account-ada', {
			ownerModule: OWNER,
			recordRef: RECORD,
			filename: 'policy.pdf',
			contentType: 'application/pdf',
			body: pdfDocument(['Cover']),
		});
		const { outcome, denied } = await call(['documents.files.manage'], {
			ownerModule: OWNER,
			recordRef: RECORD,
			documentId: pdf.id,
		});
		expect(denied).toMatchObject({ tool: DOCUMENTS_READ_TEXT_TOOL });
		expect(outcome).toMatchObject({ code: expect.any(String) });
		expect(await context.repository.findText(TENANT, pdf.id)).toBeNull();
	});
});
