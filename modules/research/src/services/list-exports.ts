import { randomBytes } from 'node:crypto';
import {
	decodeCursor,
	defineListExport,
	encodeCursor,
	type DefinedListExport,
} from '@flowdular/server';
import { RESEARCH_PERMISSIONS } from '../acl/permissions.ts';
import { RESEARCH_LIMITS, type ResearchPosition } from '../domain/types.ts';
import type {
	ResearchEvidenceView,
	ResearchService,
} from './research-service.ts';
import { neutralCell } from './results.ts';

/**
 * The evidence list as exports.core walks it: the same newest-first keyset
 * the list endpoint answers, under the principal that started the job. Title
 * and excerpt come from outside the workspace, so a value a spreadsheet would
 * run as a formula is written as text.
 */
export function researchListExports(
	service: () => Promise<ResearchService>,
): readonly DefinedListExport[] {
	const secret = randomBytes(32);
	return [
		defineListExport<ResearchEvidenceView>({
			id: 'research.core.evidence',
			label: 'Research evidence',
			permission: RESEARCH_PERMISSIONS.read,
			columns: [
				{
					key: 'retrievedAt',
					header: 'Retrieved at',
					value: (row) => new Date(row.retrievedAt),
				},
				{
					key: 'title',
					header: 'Title',
					value: (row) => neutralCell(row.title),
				},
				{ key: 'url', header: 'URL', value: (row) => neutralCell(row.url) },
				{
					key: 'contentSha256',
					header: 'Content sha256',
					value: (row) => row.contentSha256,
				},
				{ key: 'runId', header: 'Run', value: (row) => row.runId },
				{
					key: 'documentId',
					header: 'Document',
					value: (row) => row.documentId,
				},
				{
					key: 'excerpt',
					header: 'Excerpt',
					value: (row) => neutralCell(row.excerpt),
				},
			],
			page: async (principal, cursor, limit) => {
				let after: ResearchPosition | null = null;
				if (cursor !== null) {
					const value = decodeCursor(cursor, secret);
					if (!Number.isSafeInteger(value.at) || typeof value.id !== 'string') {
						throw new Error('The export cursor is not an evidence position.');
					}
					after = { at: value.at as number, id: value.id };
				}
				const page = await (
					await service()
				).listEvidence(
					principal.tenantId,
					Math.min(limit, RESEARCH_LIMITS.listMax),
					after,
				);
				return {
					rows: page.items,
					nextCursor:
						page.next === null ? null : encodeCursor({ ...page.next }, secret),
				};
			},
		}),
	];
}
