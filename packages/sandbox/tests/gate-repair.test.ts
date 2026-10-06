import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_AGENT_ROLES,
	createCodingAgentRegistry,
	type CodingAgentDriver,
	type CodingAgentTurnRequest,
} from '@flowdular/coding-agent';
import { DEFAULT_CONFIGURATION } from '../src/server/config.ts';
import {
	runGates,
	validatorIssues,
	type GateResult,
} from '../src/server/gates.ts';
import { planHandoff } from '../src/server/planning.ts';
import {
	approveSpecification,
	createSession,
	readChat,
	sessionPaths,
	type ChatEntry,
	type SandboxSession,
} from '../src/server/sessions.ts';
import {
	runTurn,
	type TurnContext,
	type TurnOutcome,
} from '../src/server/turns.ts';

/* The session of recording 4 (equipment.core on npm 0.6.1, chat sequences
   400 to 519): after the backend turn, module-schema reported client
   translation keys missing from translations/en.json, and module-rules
   reported tenant identity read from request input, interpolated SQL,
   down migrations without their mirror, and locale drift. Both repair turns
   went to the frontend engineer, which may write none of those files. */

const SPEC = `schemaVersion: 1
id: equipment.core
specVersion: 0.1.0
status: draft
name: Equipment
description: Tenant-scoped equipment register.
profile: full
capabilities:
  - api
  - database
  - translations
tenancy: required
locales:
  - en
  - pl
permissions:
  - id: equipment.items.read
    description: Read equipment in the active tenant.
`;

const UP_0001 = `CREATE TABLE IF NOT EXISTS equipment_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL
);
ALTER TABLE equipment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_items FORCE ROW LEVEL SECURITY;
CREATE POLICY equipment_items_tenant_policy ON equipment_items
  USING (tenant_id = current_setting('flowdular.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('flowdular.tenant_id', true));
`;
const DOWN_0001 = 'DROP TABLE IF EXISTS equipment_items;\n';
const UP_0002 = 'ALTER TABLE equipment_items ADD COLUMN serial_number TEXT;\n';
const DOWN_0002 =
	'ALTER TABLE equipment_items DROP COLUMN IF EXISTS serial_number;\n';

function mirror(sql: readonly string[]): string {
	return `export const databaseMigrations = [\n${sql
		.map((text) => `\t\`${text}\`,`)
		.join('\n')}\n];\n`;
}

const CLEAN_REPOSITORY = `export async function findItem(tenantId: string, id: string) {
	return query('SELECT id, name FROM equipment_items WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
}
`;

/* What the backend turn of the recording left behind. */
const RECORDED_REPOSITORY = `export async function findItem(input: { tenantId: string }, id: string) {
	const tenantId = input.tenantId;
	return query(\`SELECT id, name FROM equipment_items WHERE id = '\${id}'\`, [tenantId]);
}
`;

const MODULE_FILES: Readonly<Record<string, string>> = {
	'module.json': `${JSON.stringify({ id: 'equipment.core' })}\n`,
	'package.json': `${JSON.stringify({ name: '@flowdular/module-equipment' })}\n`,
	'spec/module.yaml': SPEC,
	'src/acl/permissions.ts':
		"export const READ = 'equipment.items.read' as const;\n",
	'src/api/endpoints.ts':
		"export const list = defineEndpoint({ id: 'equipment.list', permission: READ });\n",
	'src/services/database-repository.ts': CLEAN_REPOSITORY,
	'src/services/migration.ts': mirror([UP_0001, DOWN_0001]),
	'migrations/0001_equipment_core.up.sql': UP_0001,
	'migrations/0001_equipment_core.down.sql': DOWN_0001,
	'src/client/EquipmentView.tsrx':
		"export const title = t('equipment.page.title');\n",
	/* The client already names a key the bundles lack, and the Polish bundle
	   carries a key the English one does not. */
	'translations/en.json': `${JSON.stringify({ 'nav.equipment': 'Equipment' })}\n`,
	'translations/pl.json': `${JSON.stringify({
		'nav.equipment': 'Sprzęt',
		'page.subtitle': 'Rejestr',
	})}\n`,
};

const FIXED_BUNDLES: Readonly<Record<string, string>> = {
	'translations/en.json': `${JSON.stringify({
		'nav.equipment': 'Equipment',
		'page.title': 'Equipment',
		'page.subtitle': 'Register',
	})}\n`,
	'translations/pl.json': `${JSON.stringify({
		'nav.equipment': 'Sprzęt',
		'page.title': 'Sprzęt',
		'page.subtitle': 'Rejestr',
	})}\n`,
};

function canWrite(roleId: string, path: string): boolean {
	const role = DEFAULT_AGENT_ROLES.find((entry) => entry.id === roleId);
	return (
		role?.allowedPaths.some((pattern) => matchesGlob(path, pattern)) ?? false
	);
}

async function writeModule(
	directory: string,
	files: Readonly<Record<string, string>>,
): Promise<void> {
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(directory, path, '..'), { recursive: true });
		await writeFile(join(directory, path), text, 'utf8');
	}
}

async function approvedSession(): Promise<{
	readonly root: string;
	readonly session: SandboxSession;
	readonly module: string;
}> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-gate-repair-'));
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
		'utf8',
	);
	await writeModule(join(root, 'modules', 'equipment'), MODULE_FILES);
	const session = await createSession({
		workspaceRoot: root,
		kind: 'edit-module',
		moduleId: 'equipment.core',
		title: 'Equipment register',
		brief: 'Track equipment with status and the in-repair count.',
		blueprint: 'edit-module@1.0.0',
		role: 'backend-engineer',
		driver: 'fake',
		sourceModule: 'equipment',
		install: false,
	});
	const approved = (await approveSpecification(root, session)).session;
	return {
		root,
		session: approved,
		module: join(
			sessionPaths(root, session.id, session.moduleSuffix).workspace,
			'modules',
			'equipment',
		),
	};
}

/* Each role does what the recording needs from it, and nothing when told to
   stay idle: the backend first leaves the recorded defects and then fixes
   them; the business manager completes the bundles. */
function scriptedDriver(options: {
	readonly idle?: readonly string[];
	readonly seen?: CodingAgentTurnRequest[];
}): CodingAgentDriver {
	let backendTurns = 0;
	return {
		id: 'fake',
		label: 'Fake',
		kind: 'byok',
		requiresLoopback: false,
		description: 'test driver',
		probe: async () => ({ available: true, detail: 'ok', version: '1' }),
		async *run(request: CodingAgentTurnRequest) {
			options.seen?.push(request);
			yield {
				type: 'turn.started',
				driver: 'fake',
				role: request.role,
				resumeId: null,
			};
			const module = join(request.workspacePath, 'modules', 'equipment');
			if (!options.idle?.includes(request.role)) {
				if (request.role === 'backend-engineer') {
					backendTurns += 1;
					await writeModule(
						module,
						backendTurns === 1
							? {
									'src/services/database-repository.ts': RECORDED_REPOSITORY,
									'migrations/0002_equipment_serial.up.sql': UP_0002,
									'migrations/0002_equipment_serial.down.sql': DOWN_0002,
									'src/services/migration.ts': mirror([
										UP_0001,
										DOWN_0001,
										UP_0002,
									]),
								}
							: {
									'src/services/database-repository.ts': CLEAN_REPOSITORY,
									'src/services/migration.ts': mirror([
										UP_0001,
										DOWN_0001,
										UP_0002,
										DOWN_0002,
									]),
								},
					);
				}
				if (request.role === 'business-manager')
					await writeModule(module, FIXED_BUNDLES);
				if (request.role === 'frontend-engineer')
					await writeModule(module, {
						'src/client/EquipmentView.tsrx':
							"export const title = t('equipment.page.title');\nexport const empty = '';\n",
					});
			}
			yield {
				type: 'assistant.message',
				text: 'Done.\n\nHANDOFF: none - done',
			};
			yield {
				type: 'turn.completed',
				resumeId: null,
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				costUsd: null,
				finishReason: 'stop',
			};
		},
	};
}

/* The recorded module-schema envelope, measured against the bundle as it is
   in the session workspace now. */
async function moduleSchema(module: string): Promise<GateResult> {
	const bundle = JSON.parse(
		await readFile(join(module, 'translations', 'en.json'), 'utf8'),
	) as Record<string, string>;
	if ('page.title' in bundle)
		return {
			id: 'module-schema',
			status: 'passed',
			durationMs: 0,
			command: 'pnpm flowdular module validate --json',
			output: '{"ok":true}',
		};
	const envelope = JSON.stringify(
		{
			protocolVersion: 1,
			ok: false,
			error: {
				code: 'MODULE_VALIDATION_FAILED',
				message: 'One or more module manifests are invalid.',
				details: {
					reports: [
						{
							file: 'modules/equipment/module.json',
							valid: false,
							issues: [
								{
									code: 'TRANSLATION_KEY_MISSING',
									message:
										'Translation key "equipment.page.title" is used by the client but absent from translations/en.json.',
									path: 'src/client/EquipmentView.tsrx',
									severity: 'error',
								},
							],
						},
					],
				},
			},
		},
		null,
		2,
	);
	return {
		id: 'module-schema',
		status: 'failed',
		durationMs: 0,
		command: 'pnpm flowdular module validate --json',
		output: envelope,
		...validatorIssues(envelope),
	};
}

function turnContext(
	root: string,
	module: string,
	driver: CodingAgentDriver,
	ran: string[][] = [],
): TurnContext {
	return {
		workspaceRoot: root,
		configuration: {
			...DEFAULT_CONFIGURATION,
			mode: 'loopback',
			driver: driver.id,
		},
		registry: createCodingAgentRegistry({
			mode: 'loopback',
			drivers: [driver],
		}),
		roles: DEFAULT_AGENT_ROLES,
		platform: null,
		installDependencies: async () => ({
			ran: false,
			ok: true,
			durationMs: 0,
			output: '',
		}),
		executeGates: async ({ session, gates, modules }) => {
			ran.push([...gates]);
			const results: GateResult[] = [];
			for (const id of gates) {
				if (id === 'module-rules')
					results.push(
						...(await runGates({
							workspaceRoot: root,
							paths: sessionPaths(root, session.id, session.moduleSuffix),
							session,
							gates: ['module-rules'],
							...(modules ? { modules } : {}),
						})),
					);
				else if (id === 'module-schema')
					results.push(await moduleSchema(module));
				else
					results.push({
						id,
						status: 'passed',
						durationMs: 0,
						command: id,
						output: 'passed',
					});
			}
			return results;
		},
	};
}

async function drive(
	context: TurnContext,
	sessionId: string,
	input: { readonly message: string; readonly role: string },
): Promise<TurnOutcome> {
	const iterator = runTurn(context, {
		sessionId,
		message: input.message,
		role: input.role,
		driver: 'fake',
	});
	let step = await iterator.next();
	while (!step.done) step = await iterator.next();
	return step.value;
}

/* Runs the turn the handoff asked for, as the chain does. */
function follow(
	context: TurnContext,
	sessionId: string,
	outcome: TurnOutcome,
): Promise<TurnOutcome> {
	return drive(context, sessionId, {
		message: outcome.handoff.prompt,
		role: outcome.handoff.role,
	});
}

function latestGates(entries: readonly ChatEntry[]): Map<string, string> {
	const latest = new Map<string, string>();
	for (const entry of entries)
		if (entry.gate) latest.set(entry.gate.id, entry.gate.status);
	return latest;
}

describe('gate repair, replaying the recorded equipment session', () => {
	it('sends each failure to a role that may write the file its fix goes in', async () => {
		const { root, session, module } = await approvedSession();
		const context = turnContext(root, module, scriptedDriver({}));

		const built = await drive(context, session.id, {
			message: 'Build the equipment server.',
			role: 'backend-engineer',
		});
		expect(
			built.gates.find((gate) => gate.id === 'module-schema')?.status,
		).toBe('failed');
		expect(built.gates.find((gate) => gate.id === 'module-rules')?.status).toBe(
			'failed',
		);
		/* The missing keys belong in the locale bundles, not in the client file
		   that uses them. */
		expect(built.handoff).toMatchObject({ kind: 'continue', repair: true });
		expect(canWrite(built.handoff.role, 'translations/en.json')).toBe(true);
		expect(canWrite(built.handoff.role, 'translations/pl.json')).toBe(true);

		const translated = await follow(context, session.id, built);
		expect(
			translated.gates.find((gate) => gate.id === 'module-schema')?.status,
		).toBe('passed');
		const rules = translated.gates.find((gate) => gate.id === 'module-rules');
		expect(rules?.status).toBe('failed');
		expect(rules?.issues?.map((issue) => issue.code).sort()).toEqual([
			'migrations-mirrored',
			'no-sql-interpolation',
			'tenant-not-from-request',
		]);
		/* What remains is in the services and the migrations. */
		expect(translated.handoff).toMatchObject({
			kind: 'continue',
			repair: true,
		});
		expect(translated.handoff.reason).not.toContain('changed no files');
		for (const path of [
			'src/services/database-repository.ts',
			'src/services/migration.ts',
			'migrations/0002_equipment_serial.down.sql',
		])
			expect(canWrite(translated.handoff.role, path)).toBe(true);

		const repaired = await follow(context, session.id, translated);
		expect(repaired.gates.filter((gate) => gate.status !== 'passed')).toEqual(
			[],
		);
		expect(repaired.handoff.repair).toBeUndefined();
	});

	it('keeps a failed gate in the recorded results of a role that does not run it, until it passes', async () => {
		const { root, session, module } = await approvedSession();
		const ran: string[][] = [];
		const context = turnContext(root, module, scriptedDriver({}), ran);
		await drive(context, session.id, {
			message: 'Build the equipment server.',
			role: 'backend-engineer',
		});

		/* The frontend engineer's own gates leave module-schema out, which is
		   how the failure dropped from the recorded results at 17:51:51. */
		ran.length = 0;
		const client = await drive(context, session.id, {
			message: 'Add an empty state to the equipment view.',
			role: 'frontend-engineer',
		});
		expect(ran.flat()).toContain('module-schema');
		expect(
			client.gates.find((gate) => gate.id === 'module-schema')?.status,
		).toBe('failed');
		expect(latestGates(await readChat(root, client.session))).toEqual(
			new Map([
				['dependencies', 'passed'],
				['module-schema', 'failed'],
				['module-rules', 'failed'],
				['typecheck', 'passed'],
				['tests', 'passed'],
				['format', 'passed'],
			]),
		);

		/* Once it passes, a role that does not own it stops running it. */
		await drive(context, session.id, {
			message: 'Add the missing copy.',
			role: 'business-manager',
		});
		ran.length = 0;
		await drive(context, session.id, {
			message: 'Tidy the equipment view.',
			role: 'frontend-engineer',
		});
		expect(ran.flat()).not.toContain('module-schema');
	});

	it('reports a repair turn that changed nothing and does not send the same role again', async () => {
		const { root, session, module } = await approvedSession();
		const context = turnContext(
			root,
			module,
			scriptedDriver({ idle: ['business-manager'] }),
		);
		const built = await drive(context, session.id, {
			message: 'Build the equipment server.',
			role: 'backend-engineer',
		});
		const idle = await follow(context, session.id, built);

		expect(idle.handoff.reason).toContain('changed no files');
		expect(idle.handoff.role).not.toBe(built.handoff.role);
		expect(
			canWrite(idle.handoff.role, 'src/services/database-repository.ts'),
		).toBe(true);
	});

	it('stops for the operator when nobody else may write what an idle repair left', async () => {
		const { root, session, module } = await approvedSession();
		const context = turnContext(
			root,
			module,
			scriptedDriver({ idle: ['business-manager'] }),
		);
		/* Only the bundles are wrong: the frontend touches a client file. */
		const client = await drive(context, session.id, {
			message: 'Add an empty state to the equipment view.',
			role: 'frontend-engineer',
		});
		expect(canWrite(client.handoff.role, 'translations/en.json')).toBe(true);

		const idle = await follow(context, session.id, client);
		expect(idle.handoff.kind).toBe('blocked');
		expect(idle.handoff.reason).toContain('changed no files');
	});

	it('does not count an operator message after a repair handoff as an idle repair', async () => {
		const { root, session, module } = await approvedSession();
		const context = turnContext(
			root,
			module,
			scriptedDriver({ idle: ['business-manager'] }),
		);
		const built = await drive(context, session.id, {
			message: 'Build the equipment server.',
			role: 'backend-engineer',
		});
		expect(built.handoff.role).toBe('business-manager');

		/* The operator asks the business manager something else first; the
		   answer changes nothing and was never the repair. */
		const answered = await drive(context, session.id, {
			message: 'Which locale do our customers read first?',
			role: 'business-manager',
		});
		expect(answered.handoff.reason).not.toContain('changed no files');
		expect(answered.handoff).toMatchObject({
			kind: 'continue',
			repair: true,
			role: 'business-manager',
		});
	});

	it('gives the repair turn the errors, not the validator envelope, and marks it as an instruction', async () => {
		const { root, session, module } = await approvedSession();
		const seen: CodingAgentTurnRequest[] = [];
		const context = turnContext(root, module, scriptedDriver({ seen }));
		const built = await drive(context, session.id, {
			message: 'Build the equipment server.',
			role: 'backend-engineer',
		});
		await follow(context, session.id, built);

		const prompt = seen.at(-1)!.prompt;
		expect(prompt).toContain(
			'TRANSLATION_KEY_MISSING modules/equipment/module.json src/client/EquipmentView.tsrx: Translation key "equipment.page.title" is used by the client but absent from translations/en.json.',
		);
		expect(prompt).not.toContain('"protocolVersion"');
		expect(prompt).not.toContain('"reports"');

		const entries = await readChat(root, session);
		const operator = entries.find(
			(entry) =>
				entry.kind === 'user' && entry.text === 'Build the equipment server.',
		);
		expect(operator?.instruction).toBeUndefined();
		const instruction = entries.findLast((entry) => entry.kind === 'user');
		expect(instruction?.instruction?.gates).toEqual([
			{
				id: 'module-schema',
				status: 'failed',
				issues: [
					{
						file: 'modules/equipment/module.json',
						code: 'TRANSLATION_KEY_MISSING',
						path: 'src/client/EquipmentView.tsrx',
						message:
							'Translation key "equipment.page.title" is used by the client but absent from translations/en.json.',
					},
				],
			},
			expect.objectContaining({
				id: 'module-rules',
				module: 'equipment',
				status: 'failed',
				issues: [expect.objectContaining({ code: 'locales-complete' })],
			}),
		]);
	});
});

describe('repair routing and the role write paths', () => {
	const base = {
		routing: {
			session: {
				id: 's',
				modules: [
					{ id: 'equipment.core', directory: 'equipment', kind: 'edit' },
				],
			} as unknown as SandboxSession,
			paths: sessionPaths('/tmp/workspace', 's', 'equipment'),
			roles: DEFAULT_AGENT_ROLES,
			message: 'Build it.',
			hasSpec: true,
			hasManifest: true,
			hasServer: true,
			hasClient: true,
			specApproved: true as boolean | null,
		},
		role: 'frontend-engineer',
		module: 'equipment',
		declared: null,
		failed: false,
		changed: true,
		specApproved: true as boolean | null,
		brief: 'Track equipment.',
	};

	/* Every kind of file a gate can name reaches a role that may write it. */
	it.each([
		'translations/pl.json',
		'src/services/database-repository.ts',
		'migrations/0001_equipment_core.down.sql',
		'src/client/EquipmentView.tsrx',
		'src/agent/tools.ts',
		'spec/module.yaml',
		'tests/module.test.ts',
		'src/platform.ts',
		'src/acl/permissions.ts',
		'src/domain/types.ts',
		'module.json',
		'package.json',
	])('routes a failure in %s to a role that may write it', (path) => {
		const plan = planHandoff({
			...base,
			gates: [
				{
					id: 'module-rules',
					module: 'equipment',
					status: 'failed',
					durationMs: 0,
					command: 'rules',
					output: 'FAIL',
					issues: [{ code: 'rule', path, message: 'Broken.' }],
				},
			],
		});
		expect(plan.repair).toBe(true);
		expect(canWrite(plan.role, path)).toBe(true);
	});

	const failed = (
		gate: Pick<GateResult, 'id'> & Partial<GateResult>,
	): GateResult => ({
		status: 'failed',
		durationMs: 0,
		command: gate.id,
		output: 'failed',
		...gate,
	});
	const TRANSLATION_KEY_MISSING = {
		file: 'modules/equipment/module.json',
		code: 'TRANSLATION_KEY_MISSING',
		path: 'src/client/EquipmentView.tsrx',
		message: 'Translation key "equipment.page.title" is missing.',
	};

	it('sends a failure that names no file back to the role whose work it follows', () => {
		const typecheck = failed({
			id: 'typecheck',
			module: 'equipment',
			output: 'error: the compiler ran out of memory',
		});
		const first = planHandoff({
			...base,
			role: 'backend-engineer',
			gates: [
				failed({ id: 'module-schema', issues: [TRANSLATION_KEY_MISSING] }),
				typecheck,
			],
		});
		expect(first.role).toBe('business-manager');

		/* The bundles are fixed; the compiler still fails without a file. */
		const second = planHandoff({
			...base,
			role: 'business-manager',
			instructed: true,
			edited: true,
			previous: first,
			gates: [typecheck],
		});
		expect(second).toMatchObject({
			kind: 'continue',
			role: 'backend-engineer',
		});
	});

	it('places a specification error at the specification of the module it names', () => {
		const plan = planHandoff({
			...base,
			routing: {
				...base.routing,
				session: {
					...base.routing.session,
					modules: [
						...base.routing.session.modules,
						{ id: 'rooms.core', directory: 'rooms', kind: 'new' },
					],
				} as unknown as SandboxSession,
			},
			gates: [
				failed({
					id: 'spec-schema',
					issues: [
						{
							file: 'modules/rooms/spec/module.yaml',
							code: 'SPEC_FIELD_RESERVED',
							path: '/entities/0/fields/7/id',
							message: 'Field "room.createdAt" collides with a column.',
						},
					],
				}),
			],
		});
		expect(plan).toMatchObject({ kind: 'continue', module: 'rooms' });
		expect(canWrite(plan.role, 'spec/module.yaml')).toBe(true);
	});

	it('routes an undeclared package to a role that may write package.json, whoever ran the turn', async () => {
		const { root, session, module } = await approvedSession();
		await writeFile(
			join(module, 'src', 'services', 'pad.ts'),
			"import leftPad from 'left-pad';\nexport const pad = leftPad;\n",
			'utf8',
		);
		const gates = await runGates({
			workspaceRoot: root,
			paths: sessionPaths(root, session.id, session.moduleSuffix),
			session,
			gates: ['dependencies'],
		});
		expect(gates[0]?.status).toBe('failed');
		const plan = planHandoff({ ...base, role: 'business-manager', gates });
		expect(plan.repair).toBe(true);
		expect(canWrite(plan.role, 'package.json')).toBe(true);
	});

	it('counts the errors a repair turn was sent against what the gate reported', () => {
		const rawTable = {
			file: 'modules/equipment/module.json',
			code: 'RAW_TABLE_FORBIDDEN',
			path: 'src/services/database-repository.ts',
			message: 'Raw table access.',
		};
		const plan = planHandoff({
			...base,
			role: 'backend-engineer',
			gates: [
				failed({
					id: 'module-schema',
					issues: [TRANSLATION_KEY_MISSING, rawTable],
				}),
			],
		});
		expect(plan.role).toBe('business-manager');
		expect(plan.gates).toEqual([
			{
				id: 'module-schema',
				status: 'failed',
				issues: [TRANSLATION_KEY_MISSING],
				moreIssues: 1,
			},
		]);
		expect(plan.prompt).toContain('(1 of 2)');
	});
});
