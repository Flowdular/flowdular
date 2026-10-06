import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	MAX_GATE_ISSUES,
	runGates,
	validatorIssues,
} from '../src/server/gates.ts';
import { createSession, sessionPaths } from '../src/server/sessions.ts';

const REPOSITORY = fileURLToPath(new URL('../../..', import.meta.url));

/* The envelope `flowdular spec validate --all --json` prints when a
   specification is invalid: one report per specification in the workspace,
   the read-only reference copies included. */
function envelope(reports: readonly unknown[]): string {
	return JSON.stringify(
		{
			protocolVersion: 1,
			ok: false,
			error: {
				code: 'SPEC_VALIDATION_FAILED',
				message: 'One or more specifications are invalid.',
				details: { reports },
			},
			warnings: [],
		},
		null,
		2,
	);
}

/* Run through the workspace's own `flowdular` script, a failed nested
   package run reports itself on standard output after the envelope. */
const PNPM_TRAILER = [
	'/repository/packages/cli:',
	'[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @flowdular/cli@0.6.1 dev: `tsx src/index.ts spec validate --all --json`',
	'Exit status 1',
].join('\n');

const RESERVED = {
	code: 'SPEC_FIELD_RESERVED',
	message:
		'Field "equipment-item.createdAt" collides with the id, tenantId or createdAt column every tenant table owns.',
	path: '/entities/0/fields/7/id',
	severity: 'error',
};

describe('the errors a failed validator reports', () => {
	it('keeps the errors of the failing reports, around the package manager lines', () => {
		const braces = {
			code: 'SPEC_FIELD_INVALID',
			message: 'Field "a.{b}" is not a key: "\\"quoted\\"" } {',
			path: '/entities/0/fields/1/id',
			severity: 'error',
		};
		const stdout = `${envelope([
			{
				file: 'reference/example-module/spec/module.yaml',
				valid: true,
				issues: [
					{
						code: 'SPEC_V1',
						message: 'Version 1 specification.',
						severity: 'warning',
					},
				],
			},
			{
				file: 'modules/equipment/spec/module.yaml',
				valid: false,
				issues: [
					RESERVED,
					braces,
					{
						code: 'SPEC_NO_WIDGETS',
						message: 'No widget is declared.',
						path: '/widgets',
						severity: 'warning',
					},
				],
			},
		])}\n${PNPM_TRAILER}\n`;

		expect(validatorIssues(stdout)).toEqual({
			issues: [
				{
					file: 'modules/equipment/spec/module.yaml',
					code: 'SPEC_FIELD_RESERVED',
					path: '/entities/0/fields/7/id',
					message: RESERVED.message,
				},
				{
					file: 'modules/equipment/spec/module.yaml',
					code: 'SPEC_FIELD_INVALID',
					path: '/entities/0/fields/1/id',
					message: braces.message,
				},
			],
		});
	});

	it('counts the errors past the bound instead of dropping them in silence', () => {
		const issues = Array.from({ length: MAX_GATE_ISSUES + 3 }, (_, index) => ({
			...RESERVED,
			path: `/entities/0/fields/${index}/id`,
		}));
		const reported = validatorIssues(
			envelope([{ file: 'modules/a/spec/module.yaml', valid: false, issues }]),
		);

		expect(reported?.issues).toHaveLength(MAX_GATE_ISSUES);
		expect(reported?.moreIssues).toBe(3);
	});

	it('names the envelope error when every report passed', () => {
		const stdout = JSON.stringify({
			protocolVersion: 1,
			ok: false,
			error: {
				code: 'MODULE_ENABLED_MISSING',
				message: 'Enabled modules are not registered: booking.core',
				details: {
					reports: [
						{ file: 'modules/rooms/module.json', valid: true, issues: [] },
					],
					missingEnabled: ['booking.core'],
				},
			},
		});

		expect(validatorIssues(stdout)).toEqual({
			issues: [
				{
					code: 'MODULE_ENABLED_MISSING',
					message: 'Enabled modules are not registered: booking.core',
				},
			],
		});
	});

	it('reads nothing from output that holds no failed envelope', () => {
		for (const stdout of [
			'FAIL tests/booking.test.ts > refuses overlap',
			envelope([
				{
					file: 'modules/a/spec/module.yaml',
					valid: false,
					issues: [RESERVED],
				},
			]).slice(0, 120),
			'{"protocolVersion":1,"ok":true,"data":{"valid":true}}',
		])
			expect(validatorIssues(stdout)).toBeNull();
	});
});

describe('the spec-schema gate in the repository checkout', () => {
	it('reports reserved fields from an envelope larger than the output bound', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-gate-issues-'));
		await writeFile(
			join(root, 'flowdular.json'),
			JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
			'utf8',
		);
		const session = await createSession({
			workspaceRoot: root,
			kind: 'new-module',
			moduleId: 'booking.core',
			title: 'Booking',
			brief: 'Book a meeting room.',
			blueprint: 'new-module@1.0.0',
			role: 'business-manager',
			driver: 'fake',
			install: false,
		});
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		await mkdir(join(paths.modulePath, 'spec'), { recursive: true });
		await writeFile(
			join(paths.modulePath, 'spec', 'module.yaml'),
			[
				'schemaVersion: 2',
				'id: booking.core',
				'specVersion: 0.1.0',
				'status: draft',
				'name: Booking',
				'description: Book a meeting room.',
				'profile: full',
				'capabilities: [api, database]',
				'dependencies: []',
				'tenancy: required',
				'locales: [en]',
				'invariants: []',
				'permissions: []',
				'dataOwnership: []',
				'acceptanceScenarios: []',
				'entities:',
				...Array.from({ length: 30 }, (_, index) => [
					`  - id: booking-${index}`,
					`    name: Booking ${index}`,
					'    fields:',
					'      - id: name',
					'        type: string',
					'      - id: createdAt',
					'        type: datetime',
				]).flat(),
				'',
			].join('\n'),
		);

		/* The workspace root is this repository, whose `flowdular` script is a
		   nested package run: the same output a sandbox in the checkout gets. */
		const [gate] = await runGates({
			workspaceRoot: REPOSITORY,
			paths,
			session,
			gates: ['spec-schema'],
		}).finally(() => rm(root, { recursive: true, force: true }));

		expect(gate).toMatchObject({ id: 'spec-schema', status: 'failed' });
		/* The interleaved output the next turn reads was cut; the errors were
		   read before the cut. */
		expect(gate!.output).toContain('characters omitted');
		expect(gate!.issues).toHaveLength(MAX_GATE_ISSUES);
		expect(gate!.moreIssues).toBe(30 - MAX_GATE_ISSUES);
		expect(gate!.issues![0]).toEqual({
			file: 'modules/booking/spec/module.yaml',
			code: 'SPEC_FIELD_RESERVED',
			path: '/entities/0/fields/1/id',
			message:
				'Field "booking-0.createdAt" collides with the id, tenantId or createdAt column every tenant table owns.',
		});
	}, 120_000);
});
