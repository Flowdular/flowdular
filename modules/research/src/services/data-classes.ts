import type { DataClassDeclaration } from '@flowdular/kernel';
import type { ResearchService } from './research-service.ts';

/**
 * The service arrives as a thunk because declaring happens while the platform
 * composes, before anything has opened a database. Every operation runs on
 * this module's own lease under its own tenant transaction.
 */
export function researchDataClasses(
	service: () => Promise<ResearchService>,
): readonly DataClassDeclaration[] {
	return [
		{
			key: 'evidence',
			label: 'Research evidence',
			defaultRetentionDays: 180,
			exportable: true,
			sweep: async (input) =>
				(await service()).sweepEvidence(
					input.tenantId,
					input.cutoff,
					input.limit,
				),
			export: async (input) =>
				(await service()).exportEvidence(input.tenantId, input.sink),
			/* Evidence is cited by other modules' records, so the row stays and
			   only the account that asked for it is removed. */
			erase: async (input) =>
				(await service()).eraseEvidence(
					input.tenantId,
					input.subject.accountId,
					input.limit,
				),
			count: async (input) =>
				(await service()).countEvidence(
					input.tenantId,
					input.subject.accountId,
				),
		},
		{
			key: 'attempts',
			label: 'Research adapter attempts',
			defaultRetentionDays: 30,
			exportable: true,
			sweep: async (input) =>
				(await service()).sweepAttempts(
					input.tenantId,
					input.cutoff,
					input.limit,
				),
			export: async (input) =>
				(await service()).exportAttempts(input.tenantId, input.sink),
			/* An attempt names no account. Declared ahead of the queries, so the
			   attempts of the member's own queries go while the query row still
			   says whose they were. */
			erase: async (input) =>
				(await service()).eraseAttempts(
					input.tenantId,
					input.subject.accountId,
					input.limit,
				),
			count: async (input) =>
				(await service()).countAttempts(
					input.tenantId,
					input.subject.accountId,
				),
		},
		{
			key: 'queries',
			label: 'Research queries',
			defaultRetentionDays: 90,
			exportable: true,
			sweep: async (input) =>
				(await service()).sweepQueries(
					input.tenantId,
					input.cutoff,
					input.limit,
				),
			export: async (input) =>
				(await service()).exportQueries(input.tenantId, input.sink),
			erase: async (input) =>
				(await service()).eraseQueries(
					input.tenantId,
					input.subject.accountId,
					input.limit,
				),
			count: async (input) =>
				(await service()).countQueries(input.tenantId, input.subject.accountId),
		},
		{
			key: 'pages',
			label: 'Research page cache',
			defaultRetentionDays: 1,
			exportable: false,
			excludedReason:
				'A cache of public pages kept one day; the evidence export carries the sha256 and the excerpt of every page read.',
			sweep: async (input) =>
				(await service()).sweepPages(input.tenantId, input.cutoff, input.limit),
			erase: async (input) =>
				(await service()).erasePages(input.tenantId, input.limit),
			count: async (input) => (await service()).countPages(input.tenantId),
		},
	];
}
