import { defineApiAgentTool } from '@flowdular/harness/tool-adapters';
import type { AgentTool } from '@flowdular/harness/runtime';
import { DOCUMENTS_PERMISSIONS } from '../acl/permissions.ts';
import {
	DOCUMENT_TEMPLATE_FORMATS,
	DOCUMENT_TEMPLATE_LIMITS,
	type DocumentTemplateFormat,
} from '../domain/templates.ts';
import { DOCUMENT_TEXT_LIMITS } from '../domain/text.ts';
import { DOCUMENT_LIMITS } from '../domain/types.ts';
import type { DocumentsRuntime } from '../server/runtime.ts';
import { DocumentsServiceError } from '../services/documents-service.ts';

export const DOCUMENTS_READ_TEXT_TOOL = 'documents.read-text';
export const DOCUMENTS_RENDER_TOOL = 'documents.render';
export const DOCUMENTS_RENDER_STATUS_TOOL = 'documents.render-status';

const RENDER_OUTPUT_SCHEMA = {
	type: 'object',
	required: [
		'jobId',
		'status',
		'documentId',
		'errorCode',
		'templateKey',
		'version',
		'format',
	],
	properties: {
		jobId: { type: 'string' },
		status: {
			type: 'string',
			enum: ['queued', 'running', 'succeeded', 'failed'],
		},
		documentId: { type: ['string', 'null'] },
		errorCode: { type: ['string', 'null'] },
		templateKey: { type: 'string' },
		version: { type: 'integer' },
		format: { type: 'string', enum: [...DOCUMENT_TEMPLATE_FORMATS] },
	},
} as const;

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
		defineApiAgentTool({
			id: DOCUMENTS_RENDER_TOOL,
			endpointId: 'documents.templates.render',
			description:
				'Render a registered document template with an input for one record and store the PDF or DOCX as an attachment of that record. The input must match the template input schema. The answer carries the job id, its status (queued, running, succeeded or failed) and the document id once it succeeded; read a queued or running job later with documents.render-status rather than rendering again.',
			requiredPermissions: [
				DOCUMENTS_PERMISSIONS.templatesRead,
				DOCUMENTS_PERMISSIONS.manage,
			],
			risk: 'workspace-write',
			idempotency: 'required',
			/* document_render_keys binds the harness key to the render it first
			   reached, and document_renders keys every render by its template
			   version, record, format and input digest, so a retried call answers
			   the render and the document that already exist. */
			idempotencyProtection: 'target-ledger',
			cancellation: 'cooperative',
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['templateKey', 'ownerModule', 'recordRef', 'input'],
				properties: {
					templateKey: {
						type: 'string',
						minLength: 3,
						maxLength: DOCUMENT_TEMPLATE_LIMITS.key,
					},
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
					input: { type: 'object' },
					format: { type: 'string', enum: [...DOCUMENT_TEMPLATE_FORMATS] },
				},
			},
			outputSchema: RENDER_OUTPUT_SCHEMA,
			execute: async (input, context) => {
				const value = (input ?? {}) as Record<string, unknown>;
				return (await runtime.templatesService()).render(
					{
						/* The workspace and the account come from the run, never from the input. */
						tenantId: context.tenantId,
						principal: {
							accountId: context.requestedBy,
							scopes: [...context.permissions],
						},
						templateKey: String(value.templateKey ?? ''),
						ownerModule: String(value.ownerModule ?? ''),
						recordRef: String(value.recordRef ?? ''),
						input: value.input ?? {},
						format: value.format as DocumentTemplateFormat | undefined,
					},
					context.signal,
					context.idempotencyKey,
				);
			},
		}),
		defineApiAgentTool({
			id: DOCUMENTS_RENDER_STATUS_TOOL,
			endpointId: 'documents.templates.render-status',
			description:
				'Read the status of a document render by the job id documents.render answered: queued, running, succeeded with the document id, or failed with the error code.',
			requiredPermissions: [DOCUMENTS_PERMISSIONS.templatesRead],
			risk: 'read',
			cancellation: 'not-supported',
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['jobId'],
				properties: {
					jobId: {
						type: 'string',
						minLength: 1,
						maxLength: DOCUMENT_LIMITS.id,
					},
				},
			},
			outputSchema: RENDER_OUTPUT_SCHEMA,
			execute: async (input, context) => {
				const value = (input ?? {}) as Record<string, unknown>;
				const status = await (
					await runtime.templatesService()
				).status(
					/* The workspace comes from the run, never from the input. */
					context.tenantId,
					String(value.jobId ?? ''),
				);
				if (!status) {
					throw new DocumentsServiceError(
						'TEMPLATE_RENDER_NOT_FOUND',
						'No document render has that job id in this workspace.',
						404,
					);
				}
				return status;
			},
		}),
	];
}
