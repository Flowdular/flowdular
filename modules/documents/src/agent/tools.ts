import { defineApiAgentTool } from '@flowdular/harness/tool-adapters';
import type { AgentTool } from '@flowdular/harness/runtime';
import { DOCUMENTS_PERMISSIONS } from '../acl/permissions.ts';
import { DOCUMENT_TEXT_LIMITS } from '../domain/text.ts';
import { DOCUMENT_LIMITS } from '../domain/types.ts';
import type { DocumentsRuntime } from '../server/runtime.ts';
import { DocumentsServiceError } from '../services/documents-service.ts';

export const DOCUMENTS_READ_TEXT_TOOL = 'documents.read-text';

/** At most `bytes` of UTF-8, never splitting a character. */
function utf8Cut(
	text: string,
	bytes: number,
): { readonly text: string; readonly cut: boolean } {
	if (Buffer.byteLength(text, 'utf8') <= bytes) return { text, cut: false };
	let used = 0;
	let end = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character, 'utf8');
		if (used + size > bytes) break;
		used += size;
		end += character.length;
	}
	return { text: text.slice(0, end), cut: true };
}

export function documentsAgentTools(
	runtime: DocumentsRuntime,
): readonly AgentTool[] {
	return [
		defineApiAgentTool({
			id: DOCUMENTS_READ_TEXT_TOOL,
			endpointId: 'documents.files.text',
			description:
				'Read the text of one document attached to a record, named by its owner module, record reference and document id, optionally a page range. Pages are separated by a form feed. A long answer is cut with truncated set; read the following pages by range. Status pending means the text is still being extracted.',
			requiredPermissions: [DOCUMENTS_PERMISSIONS.read],
			risk: 'read',
			cancellation: 'not-supported',
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['ownerModule', 'recordRef', 'documentId'],
				properties: {
					ownerModule: {
						type: 'string',
						minLength: 1,
						maxLength: DOCUMENT_LIMITS.ownerModule,
					},
					recordRef: {
						type: 'string',
						minLength: 1,
						maxLength: DOCUMENT_LIMITS.recordRef,
					},
					documentId: {
						type: 'string',
						minLength: 1,
						maxLength: DOCUMENT_LIMITS.id,
					},
					pages: {
						type: 'object',
						additionalProperties: false,
						required: ['from', 'to'],
						properties: {
							from: { type: 'integer', minimum: 1 },
							to: { type: 'integer', minimum: 1 },
						},
					},
				},
			},
			execute: async (input, context) => {
				const value = (input ?? {}) as Record<string, unknown>;
				const text = await (
					await runtime.textService()
				).extract(
					/* The workspace comes from the run, never from the input. */
					context.tenantId,
					String(value.ownerModule ?? ''),
					String(value.recordRef ?? ''),
					String(value.documentId ?? ''),
					value.pages === undefined
						? {}
						: { pages: value.pages as { from: number; to: number } },
				);
				if (!text) {
					throw new DocumentsServiceError(
						'DOCUMENT_NOT_FOUND',
						'No readable document has that id on that record.',
						404,
					);
				}
				const bounded = utf8Cut(text.text, DOCUMENT_TEXT_LIMITS.toolTextBytes);
				return {
					documentId: String(value.documentId),
					status: text.status,
					reason: text.reason,
					pages: text.pages,
					from: text.from,
					to: text.to,
					truncated: text.truncated || bounded.cut,
					contentSha256: text.contentSha256,
					text: bounded.text,
				};
			},
		}),
	];
}
