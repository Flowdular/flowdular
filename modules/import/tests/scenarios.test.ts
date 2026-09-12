import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	createTracer,
	formatTraceParent,
	runWithTrace,
} from '@flowdular/server';
import type { DocumentAttachment } from '@flowdular/module-documents';
import { IMPORT_PERMISSIONS } from '../src/acl/permissions.ts';
import type { ImportPort } from '../src/domain/ports.ts';
import {
	IMPORT_MAX_CSV_BYTES,
	type ImportJob,
	type ImportRowOutcome,
} from '../src/domain/types.ts';
import {
	createImportCsvSource,
	IMPORT_OWNER_MODULE,
} from '../src/services/csv-source.ts';
import {
	ImportService,
	ImportServiceError,
} from '../src/services/import-service.ts';
import {
	openImportHarness,
	principal,
	TARGET_PERMISSION,
	TENANT,
	type ImportTestHarness,
} from './support/harness.ts';
import {
	createFakeImportPort,
	FIVE_ROW_CSV,
	MEMBERS_MAPPING,
	MEMBERS_TARGET,
	type FakeImportPort,
} from './support/port.ts';

let harness: ImportTestHarness;
let fake: FakeImportPort;

beforeAll(async () => {
	harness = await openImportHarness({ batchSize: 2 });
	fake = createFakeImportPort();
	harness.ports.register('users.core', [fake.port]);
	harness.ports.seal();
});

afterAll(async () => {
	await harness?.dispose();
});

afterEach(async () => {
	await harness.reset();
	fake.reset();
});

async function outcomes(
	job: ImportJob,
): Promise<readonly (readonly [number, ImportRowOutcome, string | null])[]> {
	const page = await harness.repository.listJobRows(job.tenantId, job.id, 200);
	return page.items.map((row) => [row.rowNumber, row.outcome, row.reason]);
}

async function startAndRun(
	body: string,
	overrides: {
		readonly mode?: ImportJob['mode'];
		readonly dryRun?: boolean;
		readonly actor?: ReturnType<typeof principal>;
	} = {},
): Promise<ImportJob> {
	const stored = await harness.storeCsv(TENANT, body);
	const job = await harness.service.start(overrides.actor ?? principal(), {
		target: MEMBERS_TARGET,
		documentId: stored.documentId,
		documentRef: stored.documentRef,
		mode: overrides.mode ?? 'create-only',
		dryRun: overrides.dryRun ?? true,
		columns: MEMBERS_MAPPING,
	});
	await harness.runner.tick();
	return harness.service.job(TENANT, job.id);
}

describe('IMPORT-START-VALIDATE', () => {
	it('validates every row, reports the invalid one and writes nothing', async () => {
		const job = await startAndRun(FIVE_ROW_CSV);

		expect({
			status: job.status,
			total: job.totalRows,
			valid: job.validRows,
			failed: job.failedRows,
			written: job.writtenRows,
		}).toEqual({
			status: 'completed',
			total: 5,
			valid: 4,
			failed: 1,
			written: 0,
		});
		expect(await outcomes(job)).toEqual([
			[1, 'valid', null],
			[2, 'valid', null],
			[3, 'valid', null],
			[4, 'invalid', 'FIELD_REQUIRED'],
			[5, 'valid', null],
		]);
		const invalid = (
			await harness.repository.listJobRows(TENANT, job.id, 200)
		).items.find((row) => row.outcome === 'invalid');
		expect([invalid?.rowNumber, invalid?.field]).toEqual([4, 'displayName']);
		expect(fake.records.get(TENANT)).toBeUndefined();
	});

	it('reports a port verdict with the port’s own field and reason', async () => {
		const rejecting = createFakeImportPort({ rejectRows: new Set([2]) });
		const harnessPorts = await openImportHarness();
		try {
			harnessPorts.ports.register('users.core', [rejecting.port]);
			harnessPorts.ports.seal();
			const stored = await harnessPorts.storeCsv(TENANT, FIVE_ROW_CSV);
			const started = await harnessPorts.service.start(principal(), {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: true,
				columns: MEMBERS_MAPPING,
			});
			await harnessPorts.runner.tick();
			const rows = await harnessPorts.repository.listJobRows(
				TENANT,
				started.id,
				200,
			);
			expect(
				rows.items
					.filter((row) => row.outcome === 'invalid')
					.map((row) => [row.rowNumber, row.field, row.reason]),
			).toEqual([
				[2, 'email', 'REJECTED_BY_PORT'],
				[4, 'displayName', 'FIELD_REQUIRED'],
			]);
		} finally {
			await harnessPorts.dispose();
		}
	});
});

describe('IMPORT-WRITE', () => {
	it('writes the valid rows in bounded batches and leaves the invalid row alone', async () => {
		const validated = await startAndRun(FIVE_ROW_CSV, { dryRun: false });
		expect(validated.status).toBe('validated');

		await harness.service.continue(principal(), validated.id, true);
		await harness.runner.tick();
		const job = await harness.service.job(TENANT, validated.id);

		expect({
			status: job.status,
			written: job.writtenRows,
			failed: job.failedRows,
		}).toEqual({ status: 'completed', written: 4, failed: 1 });
		expect(await outcomes(job)).toEqual([
			[1, 'created', null],
			[2, 'created', null],
			[3, 'created', null],
			[4, 'invalid', 'FIELD_REQUIRED'],
			[5, 'created', null],
		]);
		expect([...(fake.records.get(TENANT)?.keys() ?? [])].sort()).toEqual([
			'ada@example.com',
			'alan@example.com',
			'edsger@example.com',
			'grace@example.com',
		]);
		/* batchSize is 2, so four valid rows reach the port as 2 + 2. */
		expect(
			fake.calls
				.filter((call) => call.kind === 'write')
				.map((call) => call.rows),
		).toEqual([2, 2]);
	});

	it('refuses to continue a job with invalid rows unless the requester says valid rows only', async () => {
		const validated = await startAndRun(FIVE_ROW_CSV, { dryRun: false });
		await expect(
			harness.service.continue(principal(), validated.id, false),
		).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 409 });
		expect((await harness.service.job(TENANT, validated.id)).status).toBe(
			'validated',
		);
	});

	it('refuses to continue a dry run', async () => {
		const job = await startAndRun(FIVE_ROW_CSV, { dryRun: true });
		await expect(
			harness.service.continue(principal(), job.id, true),
		).rejects.toMatchObject({ code: 'JOB_DRY_RUN' });
	});

	it('records a row the port never answered for as failed', async () => {
		const silent = createFakeImportPort({ silentRows: new Set([3]) });
		const own = await openImportHarness({ batchSize: 500 });
		try {
			own.ports.register('users.core', [silent.port]);
			own.ports.seal();
			const stored = await own.storeCsv(TENANT, FIVE_ROW_CSV);
			const started = await own.service.start(principal(), {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: false,
				columns: MEMBERS_MAPPING,
			});
			await own.runner.tick();
			await own.service.continue(principal(), started.id, true);
			await own.runner.tick();
			const rows = await own.repository.listJobRows(TENANT, started.id, 200);
			expect(
				rows.items
					.filter((row) => row.rowNumber === 3)
					.map((row) => [row.outcome, row.reason]),
			).toEqual([['failed', 'PORT_SILENT']]);
		} finally {
			await own.dispose();
		}
	});

	it('fails a batch rather than the loop when the port throws', async () => {
		const broken = createFakeImportPort({ throws: true });
		const own = await openImportHarness();
		try {
			own.ports.register('users.core', [broken.port]);
			own.ports.seal();
			const stored = await own.storeCsv(TENANT, FIVE_ROW_CSV);
			const started = await own.service.start(principal(), {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: true,
				columns: MEMBERS_MAPPING,
			});
			await own.runner.tick();
			const job = await own.service.job(TENANT, started.id);
			expect([job.status, job.validRows, job.failedRows]).toEqual([
				'completed',
				0,
				5,
			]);
			const rows = await own.repository.listJobRows(TENANT, started.id, 200);
			expect(rows.items.every((row) => row.outcome === 'invalid')).toBe(true);
			expect(rows.items.some((row) => row.reason === 'PORT_FAILED')).toBe(true);
		} finally {
			await own.dispose();
		}
	});
});

describe('IMPORT-REPEAT', () => {
	it('skips, then updates, and never duplicates a record under the natural key', async () => {
		const write = async (mode: ImportJob['mode']) => {
			const first = await startAndRun(FIVE_ROW_CSV, { dryRun: false, mode });
			await harness.service.continue(principal(), first.id, true);
			await harness.runner.tick();
			return harness.service.job(TENANT, first.id);
		};

		const created = await write('create-only');
		expect(created.writtenRows).toBe(4);

		const skipped = await write('skip-existing');
		expect(
			(await outcomes(skipped)).filter(([, outcome]) => outcome === 'skipped'),
		).toHaveLength(4);
		/* Every row was skipped, so the job wrote nothing. */
		expect([skipped.writtenRows, skipped.failedRows]).toEqual([0, 1]);
		expect(fake.records.get(TENANT)?.size).toBe(4);

		const updated = await write('update-existing');
		expect(
			(await outcomes(updated)).filter(([, outcome]) => outcome === 'updated'),
		).toHaveLength(4);
		expect(updated.writtenRows).toBe(4);
		expect(fake.records.get(TENANT)?.size).toBe(4);
	});

	it('reports a create-only repeat as failed rather than writing a duplicate', async () => {
		const first = await startAndRun(FIVE_ROW_CSV, { dryRun: false });
		await harness.service.continue(principal(), first.id, true);
		await harness.runner.tick();

		const second = await startAndRun(FIVE_ROW_CSV, { dryRun: false });
		await harness.service.continue(principal(), second.id, true);
		await harness.runner.tick();
		const job = await harness.service.job(TENANT, second.id);
		expect(job.writtenRows).toBe(0);
		expect(
			(await outcomes(job)).filter(([, outcome]) => outcome === 'failed'),
		).toHaveLength(4);
		expect(fake.records.get(TENANT)?.size).toBe(4);
	});
});

describe('IMPORT-DUPLICATE-KEY', () => {
	/** 502 rows where row 501 repeats the natural key of row 1. */
	function repeatingCsv(): string {
		const lines = ['E-mail,Name,Role'];
		for (let row = 1; row <= 502; row += 1) {
			const email =
				row === 1 || row === 501
					? 'ada@example.com'
					: `person-${row}@example.com`;
			lines.push(`${email},Person ${row},member`);
		}
		return lines.join('\n');
	}

	/** The same 502 rows, with row 501 repeating row 1 in another case. */
	function refoldedCsv(): string {
		return repeatingCsv().replace(
			'\nada@example.com,Person 501,member',
			'\nAda@Example.com,Person 501,member',
		);
	}

	it('folds the key the way the port declaring the fold does', async () => {
		const own = await openImportHarness({ batchSize: 500 });
		const fake = createFakeImportPort();
		/* A port that stores addresses folded, as users.core members does. */
		const port: ImportPort = {
			...fake.port,
			naturalKeyOf: (values) =>
				(values.email ?? '').trim().normalize('NFKC').toLowerCase(),
		};
		try {
			own.ports.register('users.core', [port]);
			own.ports.seal();
			const stored = await own.storeCsv(TENANT, refoldedCsv());
			const started = await own.service.start(principal(), {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: false,
				columns: MEMBERS_MAPPING,
			});
			await own.runner.tick();

			const validated = await own.service.job(TENANT, started.id);
			expect([validated.validRows, validated.failedRows]).toEqual([501, 1]);
			const refused = (
				await own.repository.listJobRows(TENANT, started.id, 200, 500)
			).items.find((row) => row.rowNumber === 501);
			expect([refused?.outcome, refused?.field, refused?.reason]).toEqual([
				'invalid',
				'email',
				'NATURAL_KEY_DUPLICATE',
			]);

			await own.service.continue(principal(), started.id, true);
			await own.runner.tick();
			/* One record for that address, written by the row that named it first. */
			expect(fake.records.get(TENANT)?.size).toBe(501);
		} finally {
			await own.dispose();
		}
	});

	it('compares the key exactly when the port folds nothing', async () => {
		const job = await startAndRun(
			[
				'E-mail,Name,Role',
				'ada@example.com,Ada Lovelace,member',
				'grace@example.com,Grace Hopper,member',
				'Ada@Example.com,Ada Again,member',
			].join('\n'),
			{ dryRun: false },
		);
		/* The fake port declares no fold, so the two spellings are two keys here
		   and what they mean is the port's own answer at write. */
		expect(await outcomes(job)).toEqual([
			[1, 'valid', null],
			[2, 'valid', null],
			[3, 'valid', null],
		]);
	});

	it('refuses a row repeating a natural key from an earlier batch', async () => {
		/* One batch holds 500 rows, so the repeat and the row it repeats never
		   meet inside a port call: the whole file is what has to be checked. */
		const own = await openImportHarness({ batchSize: 500 });
		const port = createFakeImportPort();
		try {
			own.ports.register('users.core', [port.port]);
			own.ports.seal();
			const stored = await own.storeCsv(TENANT, repeatingCsv());
			const started = await own.service.start(principal(), {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: false,
				columns: MEMBERS_MAPPING,
			});
			await own.runner.tick();

			const validated = await own.service.job(TENANT, started.id);
			expect({
				status: validated.status,
				total: validated.totalRows,
				valid: validated.validRows,
				failed: validated.failedRows,
			}).toEqual({
				status: 'validated',
				total: 502,
				valid: 501,
				failed: 1,
			});
			const refused = (
				await own.repository.listJobRows(TENANT, started.id, 200, 500)
			).items.find((row) => row.rowNumber === 501);
			expect([refused?.outcome, refused?.field, refused?.reason]).toEqual([
				'invalid',
				'email',
				'NATURAL_KEY_DUPLICATE',
			]);

			await own.service.continue(principal(), started.id, true);
			await own.runner.tick();
			const completed = await own.service.job(TENANT, started.id);
			expect([completed.writtenRows, completed.failedRows]).toEqual([501, 1]);
			/* The repeat never reached the port, so it is neither a second record
			   nor somebody else's row refused as already taken. */
			expect(port.records.get(TENANT)?.size).toBe(501);
			expect(
				(await own.repository.listJobRows(TENANT, started.id, 200, 500)).items
					.filter((row) => row.rowNumber === 501)
					.map((row) => row.outcome),
			).toEqual(['invalid']);
		} finally {
			await own.dispose();
		}
	});
});

describe('IMPORT-PERMISSION', () => {
	it('refuses the start when the principal lacks the target’s own permission', async () => {
		const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
		const actor = principal([
			IMPORT_PERMISSIONS.read,
			IMPORT_PERMISSIONS.manage,
		]);
		await expect(
			harness.service.start(actor, {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: true,
				columns: MEMBERS_MAPPING,
			}),
		).rejects.toMatchObject({ code: 'TARGET_FORBIDDEN', status: 403 });
		/* No job proceeds past parsing because no job exists at all. */
		const page = await harness.repository.listJobs(TENANT, { limit: 10 });
		expect(page.items).toEqual([]);
		expect(fake.calls).toEqual([]);
	});

	it('refuses to continue after the target permission was revoked', async () => {
		const validated = await startAndRun(FIVE_ROW_CSV, { dryRun: false });
		await expect(
			harness.service.continue(
				principal([IMPORT_PERMISSIONS.read, IMPORT_PERMISSIONS.manage]),
				validated.id,
				true,
			),
		).rejects.toMatchObject({ code: 'TARGET_FORBIDDEN', status: 403 });
	});

	it('hands the port the principal that started the job', async () => {
		await startAndRun(FIVE_ROW_CSV);
		expect(new Set(fake.calls.map((call) => call.principalAccountId))).toEqual(
			new Set(['account-ada']),
		);
	});
});

describe('IMPORT-BOUNDS', () => {
	it('refuses a document that is not a CSV before a job row is written', async () => {
		const stored = await harness.storeCsv(TENANT, 'a,b\n1,2', {
			contentType: 'text/plain',
		});
		await expect(
			harness.service.start(principal(), {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: true,
				columns: MEMBERS_MAPPING,
			}),
		).rejects.toMatchObject({ code: 'SOURCE_NOT_CSV' });
		expect(
			(await harness.repository.listJobs(TENANT, { limit: 10 })).items,
		).toEqual([]);
	});

	it('refuses to open a document that is not a CSV, by the rule start applies', async () => {
		const stored = await harness.storeCsv(TENANT, 'a,b\n1,2', {
			contentType: 'text/plain',
		});
		/* One content type rule: a document start would refuse is a document no
		   stage reads either, so a job can never be started against one kind of
		   file and parsed against another. */
		await expect(
			createImportCsvSource({ attachments: () => harness.attachments }).open(
				TENANT,
				stored.documentRef,
				stored.documentId,
			),
		).rejects.toMatchObject({ code: 'SOURCE_NOT_CSV' });
	});

	it('refuses a mapping larger than the job row can record', async () => {
		const oversized = { ...MEMBERS_MAPPING, role: 'Position '.repeat(1_000) };
		const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
		await expect(
			harness.service.start(principal(), {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: true,
				columns: oversized,
			}),
		).rejects.toMatchObject({ code: 'MAPPING_TOO_LARGE' });
		await expect(
			harness.service.saveMapping(principal(), MEMBERS_TARGET, oversized),
		).rejects.toMatchObject({ code: 'MAPPING_TOO_LARGE' });
		expect(
			(await harness.repository.listJobs(TENANT, { limit: 10 })).items,
		).toEqual([]);
		expect(await harness.service.mapping(TENANT, MEMBERS_TARGET)).toBeNull();
	});

	it('refuses a document this workspace does not hold', async () => {
		const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
		await expect(
			harness.service.start(principal(), {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: 'a-reference-nobody-uploaded-against',
				mode: 'create-only',
				dryRun: true,
				columns: MEMBERS_MAPPING,
			}),
		).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND', status: 404 });
	});

	it('fails the job with a stable code when the file holds more rows than the bound', async () => {
		const own = await openImportHarness({ maxRows: 2 });
		try {
			own.ports.register('users.core', [createFakeImportPort().port]);
			own.ports.seal();
			const stored = await own.storeCsv(TENANT, FIVE_ROW_CSV);
			const started = await own.service.start(principal(), {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: true,
				columns: MEMBERS_MAPPING,
			});
			await own.runner.tick();
			const job = await own.service.job(TENANT, started.id);
			expect([job.status, job.failureCode]).toEqual([
				'failed',
				'CSV_TOO_MANY_ROWS',
			]);
			/* No row outcome is written for a file that was never parsed. */
			expect(
				(await own.repository.listJobRows(TENANT, started.id, 200)).items,
			).toEqual([]);
		} finally {
			await own.dispose();
		}
	});

	it('refuses an oversized and an infected source before a job row is written', async () => {
		const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
		const [attachment] = await harness.attachments.list(
			TENANT,
			IMPORT_OWNER_MODULE,
			stored.documentRef,
		);
		const request = {
			target: MEMBERS_TARGET,
			documentId: stored.documentId,
			documentRef: stored.documentRef,
			mode: 'create-only' as const,
			dryRun: true,
			columns: MEMBERS_MAPPING,
		};
		/* Neither bound is reachable through the real fixtures: the storage port
		   refuses an object past its own limit long before 25 MB, and an infected
		   upload never returns a document at all. The metadata the capability
		   answers with is what `start` decides on, so it is what varies here. */
		const describing = (
			attributes: Partial<DocumentAttachment>,
		): ImportService =>
			new ImportService({
				repository: harness.repository,
				ports: harness.ports,
				source: {
					describe: async () => ({ ...attachment!, ...attributes }),
					open: () => Promise.reject(new Error('not read')),
				},
				maxRows: () => 50_000,
				batchSize: () => 500,
			});

		await expect(
			describing({ bytes: IMPORT_MAX_CSV_BYTES + 1 }).start(
				principal(),
				request,
			),
		).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
		await expect(
			describing({ scan: 'infected' }).start(principal(), request),
		).rejects.toMatchObject({ code: 'SOURCE_INFECTED' });
		expect(
			(await harness.repository.listJobs(TENANT, { limit: 10 })).items,
		).toEqual([]);
	});

	it('refuses an unknown target and a mapping the target cannot accept', async () => {
		const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
		const request = {
			documentId: stored.documentId,
			documentRef: stored.documentRef,
			mode: 'create-only' as const,
			dryRun: true,
			columns: MEMBERS_MAPPING,
		};
		await expect(
			harness.service.start(principal(), {
				...request,
				target: 'nothing.core.here',
			}),
		).rejects.toMatchObject({ code: 'TARGET_UNKNOWN', status: 404 });
		await expect(
			harness.service.start(principal(), {
				...request,
				target: MEMBERS_TARGET,
				columns: { email: 'E-mail' },
			}),
		).rejects.toBeInstanceOf(ImportServiceError);
		await expect(
			harness.service.start(principal(), {
				...request,
				target: MEMBERS_TARGET,
				columns: { ...MEMBERS_MAPPING, nothing: 'Nothing' },
			}),
		).rejects.toMatchObject({ code: 'MAPPING_UNKNOWN_FIELD' });
	});

	it('fails the job when a mapped column is absent from the file', async () => {
		const stored = await harness.storeCsv(
			TENANT,
			'E-mail,Role\na@b.com,member',
		);
		const started = await harness.service.start(principal(), {
			target: MEMBERS_TARGET,
			documentId: stored.documentId,
			documentRef: stored.documentRef,
			mode: 'create-only',
			dryRun: true,
			columns: MEMBERS_MAPPING,
		});
		await harness.runner.tick();
		expect((await harness.service.job(TENANT, started.id)).failureCode).toBe(
			'MAPPING_COLUMN_MISSING',
		);
	});

	it('fails the job when a column mapped for an optional field is absent', async () => {
		const stored = await harness.storeCsv(TENANT, 'E-mail,Name\na@b.com,A');
		const started = await harness.service.start(principal(), {
			target: MEMBERS_TARGET,
			documentId: stored.documentId,
			documentRef: stored.documentRef,
			mode: 'create-only',
			dryRun: true,
			columns: MEMBERS_MAPPING,
		});
		await harness.runner.tick();
		const job = await harness.service.job(TENANT, started.id);
		/* The requester mapped Role onto a column this file does not carry, so
		   the file is not the one the mapping describes. */
		expect([job.status, job.failureCode]).toEqual([
			'failed',
			'MAPPING_COLUMN_MISSING',
		]);
		expect(
			(await harness.repository.listJobRows(TENANT, started.id, 200)).items,
		).toEqual([]);
	});

	it('refuses a start whose requester snapshot would not fit the job row', async () => {
		const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
		const wide = principal([
			IMPORT_PERMISSIONS.read,
			IMPORT_PERMISSIONS.manage,
			TARGET_PERMISSION,
			...Array.from(
				{ length: 400 },
				(_, index) => `module.core.scope.number-${index}`,
			),
		]);
		await expect(
			harness.service.start(wide, {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: true,
				columns: MEMBERS_MAPPING,
			}),
		).rejects.toMatchObject({ code: 'REQUESTER_TOO_LARGE' });
		expect(
			(await harness.repository.listJobs(TENANT, { limit: 10 })).items,
		).toEqual([]);
	});

	it('marks a ragged row invalid instead of padding or truncating it', async () => {
		const job = await startAndRun(
			['E-mail,Name,Role', 'a@b.com,A,member', 'c@d.com,C'].join('\n'),
		);
		expect(await outcomes(job)).toEqual([
			[1, 'valid', null],
			[2, 'invalid', 'ROW_RAGGED'],
		]);
	});
});

describe('IMPORT-MAPPING', () => {
	it('offers the saved mapping and replaces it for this workspace only', async () => {
		expect(await harness.service.mapping(TENANT, MEMBERS_TARGET)).toBeNull();

		const saved = await harness.service.saveMapping(
			principal(),
			MEMBERS_TARGET,
			MEMBERS_MAPPING,
		);
		expect(
			(await harness.service.mapping(TENANT, MEMBERS_TARGET))?.columns,
		).toEqual(MEMBERS_MAPPING);

		const changed = { ...MEMBERS_MAPPING, role: 'Position' };
		const replaced = await harness.service.saveMapping(
			principal(),
			MEMBERS_TARGET,
			changed,
		);
		expect(replaced.id).toBe(saved.id);
		expect(
			(await harness.service.mapping(TENANT, MEMBERS_TARGET))?.columns,
		).toEqual(changed);
		/* One template per workspace and target, not one row per save. */
		const other = await harness.service.mapping('tenant-other', MEMBERS_TARGET);
		expect(other).toBeNull();
	});

	it('refuses a mapping that points two fields at one column', async () => {
		const reused = { ...MEMBERS_MAPPING, role: 'Name' };
		await expect(
			harness.service.saveMapping(principal(), MEMBERS_TARGET, reused),
		).rejects.toMatchObject({ code: 'MAPPING_COLUMN_REUSED' });

		const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
		await expect(
			harness.service.start(principal(), {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: true,
				columns: reused,
			}),
		).rejects.toMatchObject({ code: 'MAPPING_COLUMN_REUSED' });
		expect(
			(await harness.repository.listJobs(TENANT, { limit: 10 })).items,
		).toEqual([]);
		expect(await harness.service.mapping(TENANT, MEMBERS_TARGET)).toBeNull();
	});

	it('refuses to save a mapping without the target’s own permission', async () => {
		await expect(
			harness.service.saveMapping(
				principal([IMPORT_PERMISSIONS.read, IMPORT_PERMISSIONS.manage]),
				MEMBERS_TARGET,
				MEMBERS_MAPPING,
			),
		).rejects.toMatchObject({ code: 'TARGET_FORBIDDEN', status: 403 });
	});

	it('lists every target with whether this reader may use it', () => {
		const permitted = harness.service.targets(principal());
		expect(permitted.map((entry) => [entry.target, entry.permitted])).toEqual([
			[MEMBERS_TARGET, true],
		]);
		const denied = harness.service.targets(
			principal([IMPORT_PERMISSIONS.read]),
		);
		expect(denied[0]).toMatchObject({
			permitted: false,
			permission: TARGET_PERMISSION,
		});
		expect(denied[0]?.fields.map((field) => field.id)).toEqual([
			'email',
			'displayName',
			'role',
		]);
	});
});

describe('the job lifecycle', () => {
	it('cancels a validated job and refuses to cancel anything else', async () => {
		const validated = await startAndRun(FIVE_ROW_CSV, { dryRun: false });
		const cancelled = await harness.service.cancel(principal(), validated.id);
		expect([cancelled.status, cancelled.completedAt !== null]).toEqual([
			'cancelled',
			true,
		]);
		await expect(
			harness.service.cancel(principal(), validated.id),
		).rejects.toMatchObject({ code: 'JOB_NOT_VALIDATED', status: 409 });
		/* A cancelled job never reaches the poll again. */
		expect(await harness.repository.listPendingJobs(10)).toEqual([]);
	});

	it('leaves a claimed job to the process that holds it', async () => {
		const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
		const job = await harness.service.start(principal(), {
			target: MEMBERS_TARGET,
			documentId: stored.documentId,
			documentRef: stored.documentRef,
			mode: 'create-only',
			dryRun: true,
			columns: MEMBERS_MAPPING,
		});
		const now = Date.now();
		const first = await harness.repository.claimJob({
			tenantId: TENANT,
			id: job.id,
			claimedAt: now,
			staleBefore: now - 1_000,
		});
		expect(first).not.toBeNull();
		const second = await harness.repository.claimJob({
			tenantId: TENANT,
			id: job.id,
			claimedAt: now,
			staleBefore: now - 1_000,
		});
		expect(second).toBeNull();
	});

	it('stores the trace that enqueued the job and leaves an untraced start a root', async () => {
		const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
		const start = () =>
			harness.service.start(principal(), {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: true,
				columns: MEMBERS_MAPPING,
			});
		const request = {
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			spanId: '00f067aa0ba902b7',
			sampled: true,
		};

		const traced = await runWithTrace(request, start);
		const untraced = await start();

		/* The row carries the header of the request that asked for the import.
		   Resuming it is the stage's own job, asserted in the case below. */
		expect(
			(await harness.repository.findJob(TENANT, traced.id))?.traceparent,
		).toBe(formatTraceParent(request));
		expect(
			(await harness.repository.findJob(TENANT, untraced.id))?.traceparent,
		).toBeNull();
	});

	it('performs the claimed job in the trace that enqueued it', async () => {
		const tracer = createTracer();
		const service = new ImportService({
			repository: harness.repository,
			ports: harness.ports,
			source: createImportCsvSource({
				attachments: () => harness.attachments,
			}),
			maxRows: () => 50_000,
			batchSize: () => 500,
			tracer,
		});
		const stored = await harness.storeCsv(TENANT, FIVE_ROW_CSV);
		const request = {
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			spanId: '00f067aa0ba902b7',
			sampled: true,
		};
		const job = await runWithTrace(request, () =>
			service.start(principal(), {
				target: MEMBERS_TARGET,
				documentId: stored.documentId,
				documentRef: stored.documentRef,
				mode: 'create-only',
				dryRun: true,
				columns: MEMBERS_MAPPING,
			}),
		);
		const at = Date.now();
		const claimed = await harness.repository.claimJob({
			tenantId: TENANT,
			id: job.id,
			claimedAt: at,
			staleBefore: at - 1_000,
		});

		const performed = await service.perform(claimed!);
		const span = tracer
			.drain()
			.find((recorded) => recorded.name === 'import.core perform');

		expect(performed.status).toBe('completed');
		/* The background stage belongs to the request that asked for the import,
		   not to a trace of its own. */
		expect(span?.traceId).toBe(request.traceId);
		expect(span?.parentSpanId).toBe(request.spanId);
	});

	it('refuses a port registered after the registry was sealed', () => {
		expect(() =>
			harness.ports.register('other.core', [createFakeImportPort().port]),
		).toThrow(/composes/);
	});
});
