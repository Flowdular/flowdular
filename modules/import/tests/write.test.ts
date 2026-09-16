import { describe, expect, it } from 'vitest';
import { moduleDefinition } from '../src/index.ts';
import { IMPORT_WRITE_CAPABILITY } from '../src/domain/write.ts';
import { ImportServiceError } from '../src/services/import-service.ts';
import { createImportWrite } from '../src/services/import-write.ts';
import { createImportPortRegistry } from '../src/services/port-registry.ts';
import {
	OTHER_TENANT,
	principal,
	TARGET_PERMISSION,
	TENANT,
} from './support/harness.ts';
import { createFakeImportPort, type FakePortOptions } from './support/port.ts';

function writer(options: FakePortOptions = {}, batchSize = 10) {
	const fake = createFakeImportPort(options);
	const ports = createImportPortRegistry();
	ports.register('users.core', [fake.port]);
	ports.seal();
	return {
		fake,
		write: createImportWrite({ ports, batchSize: () => batchSize }),
	};
}

const owner = principal([TARGET_PERMISSION]);

async function refusal(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (error) {
		if (error instanceof ImportServiceError) return error.code;
		throw error;
	}
	throw new Error('The call was not refused.');
}

describe('IMPORT-WRITE-CAPABILITY import.write.v1', () => {
	it('is declared under the id a consumer resolves', () => {
		expect(moduleDefinition.manifest.provides).toContain(
			IMPORT_WRITE_CAPABILITY,
		);
	});

	it('describes a registered port with its batch size and nothing for another', () => {
		const { write } = writer({}, 25);
		expect(write.describe('users.core', 'members')).toMatchObject({
			target: 'users.core.members',
			permission: TARGET_PERMISSION,
			naturalKey: ['email'],
			batchSize: 25,
		});
		expect(write.describe('users.core', 'teams')).toBeNull();
		expect(write.describe('sales.core', 'members')).toBeNull();
	});

	it('answers one outcome per row through the port validate and write, in the order given', async () => {
		const { fake, write } = writer({
			rejectRows: new Set([6]),
			silentRows: new Set([7]),
		});
		const results = await write.write({
			tenantId: TENANT,
			principal: owner,
			moduleId: 'users.core',
			portKey: 'members',
			mode: 'update-existing',
			sourceRef: 'run-1',
			rows: [
				{ row: 1, values: { email: 'ada@example.com', displayName: 'Ada' } },
				{ row: 2, values: { email: 'grace@example.com' } },
				{ row: 3, values: { email: 'not-an-address', displayName: 'X' } },
				{
					row: 4,
					values: { email: 'alan@example.com', displayName: 'Alan', team: 'x' },
				},
				{
					row: 5,
					values: { email: 'ada@example.com', displayName: 'Ada again' },
				},
				{
					row: 6,
					values: { email: 'edsger@example.com', displayName: 'Edsger' },
				},
				{
					row: 7,
					values: { email: 'barbara@example.com', displayName: 'Barbara' },
				},
			],
		});
		expect(results).toEqual([
			{ row: 1, outcome: 'created', recordRef: 'ada@example.com' },
			{
				row: 2,
				outcome: 'invalid',
				field: 'displayName',
				reason: 'FIELD_REQUIRED',
			},
			{ row: 3, outcome: 'invalid', field: 'email', reason: 'FIELD_TYPE' },
			{ row: 4, outcome: 'invalid', field: 'team', reason: 'FIELD_UNKNOWN' },
			{
				row: 5,
				outcome: 'invalid',
				field: 'email',
				reason: 'NATURAL_KEY_DUPLICATE',
			},
			{
				row: 6,
				outcome: 'invalid',
				field: 'email',
				reason: 'REJECTED_BY_PORT',
			},
			{ row: 7, outcome: 'failed', reason: 'PORT_SILENT' },
		]);
		/* The port validated the three rows the shape check left and wrote the
		   two it did not refuse itself. */
		expect(fake.calls.map((call) => [call.kind, call.rows])).toEqual([
			['validate', 3],
			['write', 2],
		]);

		const again = await write.write({
			tenantId: TENANT,
			principal: owner,
			moduleId: 'users.core',
			portKey: 'members',
			mode: 'update-existing',
			sourceRef: 'run-2',
			rows: [
				{ row: 1, values: { email: 'ada@example.com', displayName: 'Ada L' } },
			],
		});
		expect(again).toEqual([
			{ row: 1, outcome: 'updated', recordRef: 'ada@example.com' },
		]);
	});

	it('checks the port permission and the workspace on the principal before any port code runs', async () => {
		const { fake, write } = writer();
		const rows = [
			{ row: 1, values: { email: 'ada@example.com', displayName: 'Ada' } },
		];
		expect(
			await refusal(
				write.write({
					tenantId: TENANT,
					principal: principal([]),
					moduleId: 'users.core',
					portKey: 'members',
					mode: 'create-only',
					sourceRef: 'run-1',
					rows,
				}),
			),
		).toBe('TARGET_FORBIDDEN');
		expect(
			await refusal(
				write.validate({
					tenantId: TENANT,
					principal: principal([TARGET_PERMISSION], OTHER_TENANT),
					moduleId: 'users.core',
					portKey: 'members',
					rows,
				}),
			),
		).toBe('PRINCIPAL_TENANT_MISMATCH');
		expect(fake.calls).toEqual([]);
		expect(fake.records.size).toBe(0);
	});

	it('refuses an unknown port, a batch past the bound, repeated row numbers, an unknown mode and a missing source reference', async () => {
		const { fake, write } = writer({}, 2);
		const base = {
			tenantId: TENANT,
			principal: owner,
			moduleId: 'users.core',
			portKey: 'members',
			mode: 'create-only' as const,
			sourceRef: 'run-1',
		};
		const one = { email: 'ada@example.com', displayName: 'Ada' };
		expect(
			await refusal(write.write({ ...base, portKey: 'teams', rows: [] })),
		).toBe('TARGET_UNKNOWN');
		expect(
			await refusal(
				write.write({
					...base,
					rows: [
						{ row: 1, values: one },
						{ row: 2, values: one },
						{ row: 3, values: one },
					],
				}),
			),
		).toBe('BATCH_TOO_LARGE');
		expect(
			await refusal(
				write.write({
					...base,
					rows: [
						{ row: 1, values: one },
						{ row: 1, values: one },
					],
				}),
			),
		).toBe('ROWS_INVALID');
		expect(
			await refusal(
				write.write({
					...base,
					mode: 'merge' as never,
					rows: [{ row: 1, values: one }],
				}),
			),
		).toBe('MODE_UNKNOWN');
		expect(
			await refusal(
				write.write({
					...base,
					sourceRef: '',
					rows: [{ row: 1, values: one }],
				}),
			),
		).toBe('SOURCE_REF_INVALID');
		expect(fake.calls).toEqual([]);
	});

	it('validates without writing and isolates a port that throws', async () => {
		const { fake, write } = writer();
		const verdicts = await write.validate({
			tenantId: TENANT,
			principal: owner,
			moduleId: 'users.core',
			portKey: 'members',
			rows: [
				{ row: 1, values: { email: 'ada@example.com', displayName: 'Ada' } },
				{ row: 2, values: { email: 'ada@example.com' } },
			],
		});
		expect(verdicts).toEqual([
			{ row: 1, verdict: 'valid' },
			{
				row: 2,
				verdict: 'invalid',
				field: 'displayName',
				reason: 'FIELD_REQUIRED',
			},
		]);
		expect(fake.calls.map((call) => call.kind)).toEqual(['validate']);
		expect(fake.records.size).toBe(0);

		const broken = writer({ throws: true });
		const results = await broken.write.write({
			tenantId: TENANT,
			principal: owner,
			moduleId: 'users.core',
			portKey: 'members',
			mode: 'create-only',
			sourceRef: 'run-1',
			rows: [
				{ row: 1, values: { email: 'ada@example.com', displayName: 'Ada' } },
			],
		});
		expect(results).toEqual([
			{ row: 1, outcome: 'invalid', reason: 'PORT_FAILED' },
		]);
	});
});
