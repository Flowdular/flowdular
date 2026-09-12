import { describe, expect, it } from 'vitest';
import type { AuditExportRun } from '../src/domain/types.ts';
import { createAuditExportRunner } from '../src/services/audit-runners.ts';
import {
	EXPORT_ROUTING_PAGE,
	type AuditExportService,
} from '../src/services/export-service.ts';
import type {
	AuditRepository,
	ExportRunRouting,
} from '../src/services/repository.ts';

/**
 * The routing read and the claim alone: this case is about how often one pass
 * asks the queue, not about what an export writes, so the repository behind it
 * is a stub and no database is opened.
 */
const TENANT = 'tenant-bounds';

function routing(id: string): ExportRunRouting {
	return { tenantId: TENANT, id, startedAt: 0 };
}

describe('the audit export routing read bound', () => {
	it('walks one page of runs it cannot take, however deep the queue is', async () => {
		let reads = 0;
		let claims = 0;
		/* Every page is full, and only its last run can be taken. One claim per
		   page empties the queue, so an unbounded walk reads the routing table
		   again for every run the pass is allowed to claim. */
		const last = `run-${EXPORT_ROUTING_PAGE - 1}`;
		const repository = {
			listPendingExportRuns: async (limit: number) => {
				reads += 1;
				return Array.from({ length: limit }, (_, index) =>
					routing(`run-${index}`),
				);
			},
			claimExportRun: async (input: { readonly id: string }) => {
				claims += 1;
				return input.id === last
					? ({ tenantId: TENANT, id: input.id } as AuditExportRun)
					: null;
			},
			heartbeatExportRun: async () => true,
		} as unknown as AuditRepository;
		const exports = {
			perform: async () => undefined,
		} as unknown as AuditExportService;

		const runner = createAuditExportRunner({
			repository: async () => repository,
			exports: async () => exports,
			onEvent: () => undefined,
		});

		/* The pass still makes progress; what it may not do is pay for it with a
		   routing read per run. */
		expect((await runner.tick()).performed).toBeGreaterThanOrEqual(1);
		expect(reads).toBeLessThanOrEqual(2);
		expect(claims).toBeLessThanOrEqual(EXPORT_ROUTING_PAGE * 2);
	});

	it('keeps claiming across passes when the page is full of work', async () => {
		const repository = {
			listPendingExportRuns: async (limit: number) =>
				Array.from({ length: limit }, (_, index) => routing(`run-${index}`)),
			claimExportRun: async (input: { readonly id: string }) =>
				({ tenantId: TENANT, id: input.id }) as AuditExportRun,
			heartbeatExportRun: async () => true,
		} as unknown as AuditRepository;
		const exports = {
			perform: async () => undefined,
		} as unknown as AuditExportService;

		const runner = createAuditExportRunner({
			repository: async () => repository,
			exports: async () => exports,
			onEvent: () => undefined,
		});

		/* The bound on runs walked past must not cost the next pass its claims. */
		expect((await runner.tick()).performed).toBe(EXPORT_ROUTING_PAGE);
		expect((await runner.tick()).performed).toBe(EXPORT_ROUTING_PAGE);
	});
});
