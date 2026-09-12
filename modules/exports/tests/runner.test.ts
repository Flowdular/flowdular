import { describe, expect, it } from 'vitest';
import { createTracer, type JobEvent, type Tracer } from '@flowdular/server';
import type {
	ClaimedExportJob,
	ExportJobRouting,
} from '../src/domain/types.ts';
import { createExportJobRunner } from '../src/services/export-runner.ts';
import type { ExportService } from '../src/services/export-service.ts';
import type { ExportRepository } from '../src/services/repository.ts';

/* One claimable job over fakes, so the pass the runner reports is exercised
   without a database: what is asserted is what the loop records about it. */
function onePassRunner(
	options: {
		readonly tracer?: Tracer;
		readonly onEvent?: (event: JobEvent) => void;
	} = {},
) {
	const routing = { tenantId: 'tenant-1', id: 'job-1' } as ExportJobRouting;
	const claimed = {
		tenantId: 'tenant-1',
		id: 'job-1',
		claimedAt: 0,
	} as ClaimedExportJob;
	let claims = 0;
	const repository = {
		listPendingJobs: async () => (claims === 0 ? [routing] : []),
		claimJob: async () => (claims++ === 0 ? claimed : null),
		heartbeatJob: async () => true,
	} as unknown as ExportRepository;
	const service = {
		perform: async () => undefined,
	} as unknown as ExportService;
	return createExportJobRunner({
		repository: async () => repository,
		service: async () => service,
		...options,
	});
}

describe('export job runner', () => {
	it('records a pass as a span without the module composing a sink', async () => {
		const tracer = createTracer();
		const runner = onePassRunner({ tracer });

		try {
			await runner.tick();
		} finally {
			await runner.dispose();
		}
		const pass = tracer
			.drain()
			.find((span) => span.name === 'job exports.core');

		expect(pass).toMatchObject({
			kind: 'consumer',
			parentSpanId: null,
			status: 'ok',
		});
		expect(pass?.attributes['flowdular.job.performed']).toBe(1);
	});

	it('leaves the events to a sink the module passed instead', async () => {
		const tracer = createTracer();
		const events: JobEvent['type'][] = [];
		const runner = onePassRunner({
			tracer,
			onEvent: (event) => events.push(event.type),
		});

		try {
			await runner.tick();
		} finally {
			await runner.dispose();
		}

		expect(events).toContain('pass-end');
		expect(tracer.stats().recorded).toBe(0);
	});
});
