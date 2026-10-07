import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
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
   went to the frontend engineer, which may write none of those files. The
   tenant and down migration findings were false positives; the replay leaves
   an up migration unmirrored in their place. */

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

async function approvedSession(
	files: Readonly<Record<string, string>> = MODULE_FILES,
): Promise<{
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
	await writeModule(join(root, 'modules', 'equipment'), files);
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
									'src/services/migration.ts': mirror([UP_0001, DOWN_0001]),
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
			'migrations/0002_equipment_serial.up.sql',
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
		expect((await readChat(root, session)).at(-1)?.handoff).toEqual(
			idle.handoff,
		);
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

	it('stores the repair prompt redacted and still reads the repair turn as its instruction', async () => {
		const { root, session, module } = await approvedSession();
		const leaked = 'postgres://app:hunter2secret@db.internal:5432/equipment';
		const context: TurnContext = {
			...turnContext(root, module, scriptedDriver({})),
			executeGates: async ({ gates }) =>
				gates.map((id) => ({
					id,
					module: 'equipment',
					status:
						id === 'typecheck' ? ('failed' as const) : ('passed' as const),
					durationMs: 0,
					command: id,
					output:
						id === 'typecheck'
							? `src/services/database-repository.ts(2,1): error TS2554: cannot reach ${leaked}`
							: 'passed',
				})),
		};
		const built = await drive(context, session.id, {
			message: 'Build the equipment server.',
			role: 'backend-engineer',
		});
		expect(built.handoff).toMatchObject({
			kind: 'continue',
			repair: true,
			role: 'backend-engineer',
		});
		expect(built.handoff.prompt).toContain(leaked);
		const stored = (await readChat(root, session)).findLast(
			(entry) => entry.handoff,
		)!.handoff!;
		expect(stored.prompt).not.toContain('hunter2secret');
		expect(stored.prompt).toContain('postgres://[redacted]@db.internal');

		/* The chain sends the prompt as planned, not as stored. */
		await follow(context, session.id, built);
		const instruction = (await readChat(root, session)).findLast(
			(entry) => entry.kind === 'user',
		);
		expect(instruction?.instruction?.gates).toEqual([
			{ id: 'typecheck', module: 'equipment', status: 'failed' },
		]);
	});
});

/* The session of recording 5 (equipment.core on npm 0.6.2, chat sequences
   735 to 936): the frontend engineer rewrote the list screen with keys the
   bundles lack, said translations/ was outside its write scope and handed
   the keys to the UX designer, who may not write them either. Module
   validation did not run after the client turn, because it had passed
   before and the frontend's own gates leave it out. */
const RUN5_FILES = { ...MODULE_FILES, ...FIXED_BUNDLES };

const RUN5_CLIENT = [
	"export const title = t('equipment.page.title');",
	"export const search = t('equipment.search.label');",
	"export const retire = t('equipment.retire.confirm');",
	'',
].join('\n');

const RUN5_FRONTEND = `I rewrote the list screen to cover all five review findings. The screen's new text has no translations yet, so it will show raw keys until they are added.

**Translations:** I can't write to \`translations/\`. These keys need adding to both \`en.json\` and \`pl.json\`, all under the \`equipment.\` namespace:
- \`search.label\`
- \`retire.confirm\`

HANDOFF: ux-designer - add the listed equipment.* translation keys to translations/en.json and pl.json (outside my write scope) and inspect the rendered list, drawer and retire dialog`;

const RUN5_COPY_FIXES = `I tidied the list screen. Two existing strings read badly, and translations/ is outside my write scope.

HANDOFF: ux-designer - apply the two copy fixes to translations/en.json and pl.json (outside my write scope) and inspect the rendered list`;

const RUN5_UX = `I couldn't add the missing translations: that folder is outside what I'm allowed to change (\`src/client/**\`), so I made no edits.

HANDOFF: business-manager - add the listed equipment.* keys and the two copy fixes to translations/en.json and pl.json, which are outside my write scope`;

function run5Driver(options: {
	readonly client: string;
	readonly closing: string;
	readonly roles: string[];
}): CodingAgentDriver {
	return {
		id: 'fake',
		label: 'Fake',
		kind: 'byok',
		requiresLoopback: false,
		description: 'test driver',
		probe: async () => ({ available: true, detail: 'ok', version: '1' }),
		async *run(request: CodingAgentTurnRequest) {
			options.roles.push(request.role);
			yield {
				type: 'turn.started',
				driver: 'fake',
				role: request.role,
				resumeId: null,
			};
			const module = join(request.workspacePath, 'modules', 'equipment');
			let text = 'Done.\n\nHANDOFF: none - done';
			if (request.role === 'frontend-engineer') {
				await writeModule(module, {
					'src/client/EquipmentView.tsrx': options.client,
				});
				text = options.closing;
			}
			if (request.role === 'ux-designer') text = RUN5_UX;
			if (request.role === 'business-manager') {
				const keys = {
					'nav.equipment': 'Equipment',
					'page.title': 'Equipment',
					'page.subtitle': 'Equipment register',
					'search.label': 'Search',
					'retire.confirm': 'Retire',
				};
				await writeModule(module, {
					'translations/en.json': `${JSON.stringify(keys)}\n`,
					'translations/pl.json': `${JSON.stringify(keys)}\n`,
				});
			}
			yield { type: 'assistant.message', text };
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

/* The translation key check of module validation, measured against the
   client sources and the English bundle as they are now. */
async function translationKeyCheck(module: string): Promise<GateResult> {
	const bundle = JSON.parse(
		await readFile(join(module, 'translations', 'en.json'), 'utf8'),
	) as Record<string, string>;
	const issues: Record<string, string>[] = [];
	const client = join(module, 'src', 'client');
	for (const file of await readdir(client, { recursive: true })) {
		if (!file.endsWith('.tsrx')) continue;
		const source = await readFile(join(client, file), 'utf8');
		for (const match of source.matchAll(/\bt\('equipment\.([a-z.]+)'\)/gi))
			if (!(match[1]! in bundle))
				issues.push({
					code: 'TRANSLATION_KEY_MISSING',
					message: `Translation key "equipment.${match[1]}" is used by the client but absent from translations/en.json.`,
					path: `src/client/${file}`,
					severity: 'error',
				});
	}
	const command = 'pnpm flowdular module validate --json';
	if (issues.length === 0)
		return {
			id: 'module-schema',
			status: 'passed',
			durationMs: 0,
			command,
			output: '{"ok":true}',
		};
	const envelope = JSON.stringify({
		protocolVersion: 1,
		ok: false,
		error: {
			code: 'MODULE_VALIDATION_FAILED',
			message: 'One or more module manifests are invalid.',
			details: {
				reports: [
					{ file: 'modules/equipment/module.json', valid: false, issues },
				],
			},
		},
	});
	return {
		id: 'module-schema',
		status: 'failed',
		durationMs: 0,
		command,
		output: envelope,
		...validatorIssues(envelope),
	};
}

function run5Context(
	root: string,
	module: string,
	driver: CodingAgentDriver,
	ran: string[][],
	roles = DEFAULT_AGENT_ROLES,
): TurnContext {
	return {
		...turnContext(root, module, driver),
		roles,
		executeGates: async ({ gates }) => {
			ran.push([...gates]);
			const results: GateResult[] = [];
			for (const id of gates)
				results.push(
					id === 'module-schema'
						? await translationKeyCheck(module)
						: {
								id,
								status: 'passed',
								durationMs: 0,
								command: id,
								output: 'passed',
							},
				);
			return results;
		},
	};
}

describe('handoff scope, replaying the recorded run 5 frontend turn', () => {
	it('checks the translation keys after a client turn and sends the missing ones to a role that may write translations/', async () => {
		const { root, session, module } = await approvedSession(RUN5_FILES);
		const roles: string[] = [];
		const ran: string[][] = [];
		const context = run5Context(
			root,
			module,
			run5Driver({ client: RUN5_CLIENT, closing: RUN5_FRONTEND, roles }),
			ran,
		);

		const client = await drive(context, session.id, {
			message:
				'Rewrite the equipment list screen to cover the review findings.',
			role: 'frontend-engineer',
		});
		expect(ran.flat()).toContain('module-schema');
		const keys = client.gates.find((gate) => gate.id === 'module-schema');
		expect(keys?.status).toBe('failed');
		expect(keys?.issues?.map((issue) => issue.code)).toEqual([
			'TRANSLATION_KEY_MISSING',
			'TRANSLATION_KEY_MISSING',
		]);
		expect(client.handoff).toMatchObject({ kind: 'continue', repair: true });
		expect(client.handoff.role).not.toBe('ux-designer');
		expect(canWrite(client.handoff.role, 'translations/en.json')).toBe(true);
		expect(canWrite(client.handoff.role, 'translations/pl.json')).toBe(true);

		const translated = await follow(context, session.id, client);
		expect(
			translated.gates.find((gate) => gate.id === 'module-schema')?.status,
		).toBe('passed');
		expect(roles).not.toContain('ux-designer');
	});

	it('hands work named outside the write paths to a role that may write it, and runs the key check after the translations change', async () => {
		const { root, session, module } = await approvedSession(RUN5_FILES);
		const roles: string[] = [];
		const ran: string[][] = [];
		const context = run5Context(
			root,
			module,
			run5Driver({
				client: "export const title = t('equipment.page.title');\n",
				closing: RUN5_COPY_FIXES,
				roles,
			}),
			ran,
		);

		const client = await drive(context, session.id, {
			message: 'Tidy the equipment list screen.',
			role: 'frontend-engineer',
		});
		expect(client.gates.every((gate) => gate.status === 'passed')).toBe(true);
		expect(client.handoff).toMatchObject({
			kind: 'continue',
			role: 'business-manager',
		});
		expect(client.handoff.repair).toBeUndefined();
		expect(client.handoff.reason).toContain(
			'UX designer may not write translations/en.json, so Business manager takes it.',
		);
		expect(client.handoff.prompt).toContain('apply the two copy fixes');

		ran.length = 0;
		await follow(context, session.id, client);
		expect(roles).toEqual(['frontend-engineer', 'business-manager']);
		expect(ran.flat()).toContain('module-schema');
	});

	it('stops for the operator when no role may write the work a handoff names', async () => {
		const { root, session, module } = await approvedSession(RUN5_FILES);
		const roles: string[] = [];
		const context = run5Context(
			root,
			module,
			run5Driver({
				client: "export const title = t('equipment.page.title');\n",
				closing: RUN5_COPY_FIXES,
				roles,
			}),
			[],
			DEFAULT_AGENT_ROLES.filter((role) => role.id !== 'business-manager'),
		);

		const client = await drive(context, session.id, {
			message: 'Tidy the equipment list screen.',
			role: 'frontend-engineer',
		});
		expect(client.handoff.kind).toBe('blocked');
		expect(client.handoff.reason).toBe(
			'Frontend engineer handed on work in translations/en.json, which no specialist in this session may write, so the chain stops here. Make that change by hand, or say what should change.',
		);
		expect((await readChat(root, session)).at(-1)?.handoff).toEqual(
			client.handoff,
		);
		expect(roles).toEqual(['frontend-engineer']);
	});

	it('checks the translations a turn wrote once the module has its manifest, never before the scaffold', async () => {
		const root = await mkdtemp(join(tmpdir(), 'flowdular-gate-repair-'));
		const session = await createSession({
			workspaceRoot: root,
			kind: 'new-module',
			moduleId: 'equipment.core',
			title: 'Equipment register',
			brief: 'Track equipment with status and the in-repair count.',
			blueprint: 'new-module@1.0.0',
			role: 'business-manager',
			driver: 'fake',
			install: false,
		});
		const module = join(
			sessionPaths(root, session.id, session.moduleSuffix).workspace,
			'modules',
			'equipment',
		);
		const ran: string[][] = [];
		const context = run5Context(
			root,
			module,
			run5Driver({ client: '', closing: '', roles: [] }),
			ran,
		);
		const terms = () =>
			drive(context, session.id, {
				message: 'Define the equipment terminology.',
				role: 'business-manager',
			});

		await terms();
		expect(ran.flat()).toContain('spec-schema');
		for (const gate of ['module-schema', 'tests', 'typecheck', 'format'])
			expect(ran.flat()).not.toContain(gate);

		/* What the scaffold leaves: a manifest, a screen and empty bundles. */
		await writeModule(module, {
			'module.json': `${JSON.stringify({ id: 'equipment.core' })}\n`,
			'src/client/EquipmentView.tsrx': RUN5_CLIENT,
			'translations/en.json': '{}\n',
			'translations/pl.json': '{}\n',
		});
		ran.length = 0;
		const translated = await terms();
		expect(ran.flat()).toContain('module-schema');
		expect(
			translated.gates.find((gate) => gate.id === 'module-schema')?.status,
		).toBe('passed');
	});
});

/* The run 5 shakedown on npm 0.6.2 (chat sequences 1254 to 1323): after the
   UX designer edited src/client/EquipmentView.tsrx only typecheck, format and
   dependencies ran, and after the business manager edited both bundles only
   spec-schema and dependencies. Neither role lists the tests, and the
   business manager lists no compiler, formatter or key check. */
function shakedownDriver(): CodingAgentDriver {
	return {
		id: 'fake',
		label: 'Fake',
		kind: 'byok',
		requiresLoopback: false,
		description: 'test driver',
		probe: async () => ({ available: true, detail: 'ok', version: '1' }),
		async *run(request: CodingAgentTurnRequest) {
			yield {
				type: 'turn.started',
				driver: 'fake',
				role: request.role,
				resumeId: null,
			};
			const module = join(request.workspacePath, 'modules', 'equipment');
			if (request.role === 'ux-designer')
				await writeModule(module, {
					'src/client/EquipmentView.tsrx': [
						"export const title = t('equipment.page.title');",
						"export const subtitle = t('equipment.page.subtitle');",
						'',
					].join('\n'),
				});
			if (request.role === 'business-manager') {
				const keys = {
					'nav.equipment': 'Equipment',
					'page.title': 'Equipment',
					'page.subtitle': 'Equipment register',
				};
				await writeModule(module, {
					'translations/en.json': `${JSON.stringify(keys)}\n`,
					'translations/pl.json': `${JSON.stringify(keys)}\n`,
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

describe('gates for the files a turn wrote, replaying the run 5 shakedown', () => {
	it('runs the tests, the compiler, the formatter and the key check after a client turn and after a translation turn', async () => {
		const { root, session, module } = await approvedSession(RUN5_FILES);
		const context = run5Context(root, module, shakedownDriver(), []);

		for (const [role, message, written] of [
			[
				'ux-designer',
				'Show the load error inside the card.',
				'src/client/EquipmentView.tsrx',
			],
			[
				'business-manager',
				'Remove the unused error key from both bundles.',
				'translations/en.json',
			],
		] as const) {
			const outcome = await drive(context, session.id, { message, role });
			expect(outcome.diffs.map((diff) => diff.path)).toContain(written);
			const ran = outcome.gates.map((gate) => gate.id);
			for (const gate of ['tests', 'typecheck', 'format', 'module-schema'])
				expect(ran, `${gate} after the ${role} turn`).toContain(gate);
			/* The rules measure the build against the specification, which the
			   business manager may have changed with the bundles. */
			if (role === 'business-manager')
				expect(ran).not.toContain('module-rules');
		}
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

	it('never hands the work a handoff line names to a role that may not write it, whichever choice named that role', () => {
		const gates = [
			failed({ id: 'module-rules', module: 'equipment', status: 'passed' }),
		];
		/* The frontend engineer may not hand to the business manager, so the
		   state routing chose the backend engineer. */
		const routed = planHandoff({
			...base,
			gates,
			declared: {
				role: 'business-manager',
				reason:
					'add the listed keys to translations/en.json, outside my write scope',
			},
		});
		expect(routed).toMatchObject({
			kind: 'continue',
			role: 'business-manager',
		});
		expect(routed.prompt).toContain('add the listed keys');
		expect(
			planHandoff({
				...base,
				gates,
				declared: {
					role: 'ux-designer',
					reason: 'reword the empty state in ./translations/pl.json',
				},
			}).role,
		).toBe('business-manager');

		/* Work named in another module of the session is done there. */
		const elsewhere = planHandoff({
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
			gates,
			declared: {
				role: 'ux-designer',
				reason: 'add the room labels to modules/rooms/translations/en.json',
			},
		});
		expect(elsewhere).toMatchObject({
			kind: 'continue',
			role: 'business-manager',
			module: 'rooms',
		});

		/* A role that may write what the line names keeps the handoff, and a
		   file of a module outside the session is a reference, not work. */
		for (const [role, reason] of [
			['backend-engineer', 'return the count from src/api/endpoints.ts'],
			[
				'ux-designer',
				'match the layout of modules/catalog/src/client/CatalogView.tsrx',
			],
		] as const)
			expect(
				planHandoff({ ...base, gates, declared: { role, reason } }).role,
			).toBe(role);
	});

	it('sends a failed review to a role that may write the files the reviewer named', () => {
		const plan = planHandoff({
			...base,
			role: 'backend-engineer',
			reviewing: true,
			gates: [
				failed({
					id: 'auto-review',
					module: 'equipment',
					output: 'Use $module-update to fix the findings in your review.',
				}),
			],
			declared: {
				role: 'ux-designer',
				reason: 'add the missing keys to translations/en.json and pl.json',
			},
		});
		expect(plan).toMatchObject({ kind: 'continue', repair: true });
		expect(canWrite(plan.role, 'translations/en.json')).toBe(true);
	});
});
