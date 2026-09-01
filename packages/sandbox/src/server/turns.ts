import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	access,
	cp,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
	composeInstruction,
	findRole,
	parseHandoff,
	type AgentRoleDefinition,
	type CodingAgentEvent,
	type CodingAgentMessage,
	type CodingAgentRegistry,
	type HandoffDeclaration,
} from '@coreloom/coding-agent';
import type { SandboxConfiguration } from './config.ts';
import { diffTrees, type FileDiff } from './diff.ts';
import {
	formatDirectory,
	isGateId,
	runGates,
	type GateId,
	type GateResult,
} from './gates.ts';
import { planHandoff, routeRole, type RoutingContext } from './planning.ts';
import type { PlatformClient } from './platform-client.ts';
import { listSkills, writeAgentPointer } from './reference.ts';
import {
	appendChatEntry,
	basePathOf,
	installSessionDependencies,
	modulePathOf,
	readChat,
	readSession,
	sessionPaths,
	updateSession,
	type ChatEntry,
	type HandoffPlan,
	type SandboxSession,
	type SessionModule,
	type SessionPaths,
} from './sessions.ts';
import type { InstallResult } from './workspace-install.ts';
import { SandboxSetupError } from './workspace-root.ts';

export interface TurnContext {
	readonly workspaceRoot: string;
	readonly configuration: SandboxConfiguration;
	readonly registry: CodingAgentRegistry;
	readonly roles: readonly AgentRoleDefinition[];
	readonly platform: PlatformClient | null;
	/* Installs the session workspace; defaults to pnpm. Tests replace it. */
	readonly installDependencies?: (
		session: SandboxSession,
	) => Promise<InstallResult>;
}

export interface TurnInput {
	readonly sessionId: string;
	readonly message: string;
	readonly role?: string;
	readonly driver?: string;
	readonly signal?: AbortSignal;
}

/* A diff of one draft module, named by the module directory it belongs to. */
export interface SessionFileDiff extends FileDiff {
	readonly module: string;
}

export interface TurnOutcome {
	readonly session: SandboxSession;
	readonly diffs: readonly SessionFileDiff[];
	readonly gates: readonly GateResult[];
	readonly handoff: HandoffPlan;
}

const MAX_HISTORY_MESSAGES = 20;

function historyFrom(entries: readonly ChatEntry[]): CodingAgentMessage[] {
	/* Orchestrator feedback, gate failures included, is replayed as user input
	   so the next turn can act on it. */
	return entries
		.filter(
			(entry) =>
				entry.kind !== 'event' &&
				typeof entry.text === 'string' &&
				entry.text.trim().length > 0,
		)
		.slice(-MAX_HISTORY_MESSAGES)
		.map((entry) => ({
			role: entry.kind === 'agent' ? ('assistant' as const) : ('user' as const),
			text: entry.text!,
		}));
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/* Most modules declare their endpoints in src/api/endpoints.ts, but a module
   may compose its server from src/platform.ts or several files under
   src/server. Any of the three means the server surface exists. */
async function hasServerSurface(modulePath: string): Promise<boolean> {
	if (await exists(join(modulePath, 'src/api/endpoints.ts'))) return true;
	if (await exists(join(modulePath, 'src/platform.ts'))) return true;
	try {
		return (await readdir(join(modulePath, 'src/server'))).length > 0;
	} catch {
		return false;
	}
}

async function routingContext(
	context: TurnContext,
	session: SandboxSession,
	paths: SessionPaths,
	message: string,
	entries: readonly ChatEntry[],
): Promise<RoutingContext> {
	return {
		session,
		paths,
		roles: context.roles,
		message,
		hasSpec: await exists(join(paths.modulePath, 'spec/module.yaml')),
		hasManifest: await exists(join(paths.modulePath, 'module.json')),
		hasServer: await hasServerSurface(paths.modulePath),
		hasClient: await exists(
			join(paths.modulePath, 'src/client/contribution.tsrx'),
		),
		lastHandoff:
			entries.filter((entry) => entry.handoff).at(-1)?.handoff ?? null,
	};
}

/* Only a new module waits for approval. An existing module already carries an
   approved specification, so a change to it is never gated on one. */
async function specApproval(
	session: SandboxSession,
	paths: SessionPaths,
): Promise<boolean | null> {
	if (session.kind !== 'new-module') return null;
	try {
		const spec = await readFile(
			join(paths.modulePath, 'spec', 'module.yaml'),
			'utf8',
		);
		return /^status:\s*approved\s*$/m.test(spec);
	} catch {
		return null;
	}
}

function handoffText(handoff: HandoffPlan): string {
	if (handoff.kind === 'continue') {
		return `Handing off to ${handoff.roleName}. ${handoff.reason}`;
	}
	if (handoff.kind === 'approval') {
		return `${handoff.reason} Approve it to let ${handoff.roleName} implement it.`;
	}
	if (handoff.kind === 'question') {
		return `${handoff.reason} Answer below to continue.`;
	}
	return handoff.reason;
}

function runCli(
	workspaceRoot: string,
	args: readonly string[],
): Promise<{ code: number | null; output: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn(
			'pnpm',
			['--dir', workspaceRoot, '--silent', 'oerp', ...args],
			{
				cwd: workspaceRoot,
				env: { ...process.env, FORCE_COLOR: '0' },
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
		let output = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		const append = (chunk: string) => {
			output = (output + chunk).slice(0, 8_000);
		};
		child.stdout.on('data', append);
		child.stderr.on('data', append);
		child.on('error', (error) =>
			resolvePromise({ code: null, output: error.message }),
		);
		child.on('close', (code) => resolvePromise({ code, output }));
	});
}

async function listFiles(root: string, directory = root): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name === 'node_modules') continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
		else files.push(relative(root, path));
	}
	return files;
}

/* The scaffold refuses a target directory that holds anything but the
   specification, while a business manager may already have written
   translations there. Those files step aside for the scaffold and come back
   over the skeleton, so what the specialist wrote wins over the generated
   placeholder. */
async function withScaffoldClearance<T>(
	modulePath: string,
	run: () => Promise<T>,
): Promise<T> {
	const extras = (await listFiles(modulePath)).filter(
		(file) => file !== 'spec/module.yaml',
	);
	if (extras.length === 0) return run();
	const stash = await mkdtemp(join(tmpdir(), 'coreloom-scaffold-'));
	try {
		for (const file of extras) {
			await cp(join(modulePath, file), join(stash, file));
			await rm(join(modulePath, file), { force: true });
		}
		for (const directory of await readdir(modulePath)) {
			if (directory === 'spec') continue;
			await rm(join(modulePath, directory), { recursive: true, force: true });
		}
		return await run();
	} finally {
		for (const file of extras) {
			await cp(join(stash, file), join(modulePath, file), { force: true });
		}
		await rm(stash, { recursive: true, force: true });
	}
}

/* A new module is created by the same capability the CLI exposes, from the
   specification the business manager wrote. The sandbox never hand-writes a
   module skeleton of its own, and it formats the skeleton right away so the
   format gate reports the specialist's files, not the generator's. */
export async function scaffoldFromSpec(
	context: TurnContext,
	session: SandboxSession,
): Promise<string | null> {
	const paths = sessionPaths(
		context.workspaceRoot,
		session.id,
		session.moduleSuffix,
	);
	const notes: string[] = [];
	for (const module of session.modules) {
		if (module.kind !== 'new') continue;
		const modulePath = modulePathOf(paths, module.directory);
		const specPath = join(modulePath, 'spec', 'module.yaml');
		if (!(await exists(specPath))) continue;
		if (await exists(join(modulePath, 'module.json'))) continue;
		const spec = await readFile(specPath, 'utf8');
		if (!/^status:\s*approved\s*$/m.test(spec)) {
			notes.push(
				`The ${module.id} specification is not approved yet, so the module skeleton was not created.`,
			);
			continue;
		}
		const result = await withScaffoldClearance(modulePath, () =>
			runCli(context.workspaceRoot, [
				'module',
				'new',
				module.id,
				'--spec',
				join('modules', module.directory, 'spec', 'module.yaml'),
				'--apply',
				'--root',
				paths.workspace,
				'--json',
			]),
		);
		if (result.code !== 0) {
			notes.push(
				`The module scaffold for ${module.id} failed (exit ${result.code ?? 'signal'}): ${result.output.slice(0, 1_500) || 'the command produced no output.'}`,
			);
			continue;
		}
		await formatDirectory(context.workspaceRoot, modulePath);
		notes.push(
			`Created the module skeleton for ${module.id} from its approved specification.`,
		);
	}
	return notes.length > 0 ? notes.join('\n') : null;
}

/* Diffs are recomputed only when a file under the base or the draft changed.
   The signature is one stat per file, the diff is an LCS per changed file. */
interface DiffCacheEntry {
	readonly signature: string;
	readonly diffs: readonly SessionFileDiff[];
}
const diffCache = new Map<string, DiffCacheEntry>();
const DIFF_CACHE_LIMIT = 64;

async function treeSignature(
	hash: ReturnType<typeof createHash>,
	root: string,
): Promise<void> {
	for (const file of (await listFiles(root)).sort()) {
		try {
			const info = await stat(join(root, file));
			hash.update(`${file}\0${info.mtimeMs}\0${info.size}\n`);
		} catch {
			continue;
		}
	}
}

export async function collectDiffs(
	workspaceRoot: string,
	session: SandboxSession,
): Promise<readonly SessionFileDiff[]> {
	const paths = sessionPaths(workspaceRoot, session.id, session.moduleSuffix);
	const hash = createHash('sha1');
	for (const module of session.modules) {
		hash.update(`${module.directory}\n`);
		await treeSignature(hash, basePathOf(paths, module.directory));
		await treeSignature(hash, modulePathOf(paths, module.directory));
	}
	const signature = hash.digest('hex');
	const cached = diffCache.get(session.id);
	if (cached && cached.signature === signature) return cached.diffs;

	const diffs: SessionFileDiff[] = [];
	for (const module of session.modules) {
		for (const diff of await diffTrees(
			basePathOf(paths, module.directory),
			modulePathOf(paths, module.directory),
		)) {
			diffs.push({ ...diff, module: module.directory });
		}
	}
	if (diffCache.size >= DIFF_CACHE_LIMIT) {
		diffCache.delete(diffCache.keys().next().value!);
	}
	diffCache.set(session.id, { signature, diffs });
	return diffs;
}

export function forgetDiffs(sessionId: string): void {
	diffCache.delete(sessionId);
}

export async function runSessionGates(
	context: TurnContext,
	session: SandboxSession,
	gates: readonly string[],
): Promise<readonly GateResult[]> {
	const selected = gates.filter(isGateId) as GateId[];
	if (selected.length === 0) return [];
	return runGates({
		workspaceRoot: context.workspaceRoot,
		paths: sessionPaths(
			context.workspaceRoot,
			session.id,
			session.moduleSuffix,
		),
		session,
		gates: selected,
	});
}

/* The dependency install is a gate in everything but name: when a declared
   package cannot be installed, the specialist must hear it as a failure with
   the installer's output, not as a typecheck error about a missing module. */
async function installGate(
	context: TurnContext,
	session: SandboxSession,
): Promise<GateResult | null> {
	const install =
		context.installDependencies ??
		((target: SandboxSession) =>
			installSessionDependencies(context.workspaceRoot, target));
	const result = await install(session);
	if (!result.ran) return null;
	return {
		id: 'dependencies',
		status: result.ok ? 'passed' : 'failed',
		durationMs: result.durationMs,
		command: 'pnpm install (session workspace)',
		output: result.ok
			? `Installed the session workspace in ${result.durationMs} ms.`
			: `The session workspace could not install the declared dependencies:\n${result.output}`,
	};
}

function allowedPathsFor(
	role: AgentRoleDefinition,
	modules: readonly SessionModule[],
): readonly string[] {
	return modules.flatMap((module) =>
		role.allowedPaths.map((path) => `modules/${module.directory}/${path}`),
	);
}

function gateSummary(gate: GateResult): string {
	const label = gate.module ? `${gate.id} (modules/${gate.module})` : gate.id;
	return gate.status === 'failed'
		? `Gate ${label} failed.\nCommand: ${gate.command}\n\n${gate.output}`
		: `Gate ${label}: ${gate.status}`;
}

/* One chat turn: the selected role drives the selected driver inside the
   session workspace, every event is appended to the durable chat log, and the
   diff plus the role's gates are collected when the driver finishes. */
export async function* runTurn(
	context: TurnContext,
	input: TurnInput,
): AsyncGenerator<ChatEntry, TurnOutcome> {
	const session = await readSession(context.workspaceRoot, input.sessionId);
	const paths = sessionPaths(
		context.workspaceRoot,
		session.id,
		session.moduleSuffix,
	);
	const message = input.message.trim();
	if (message.length < 1 || message.length > 20_000) {
		throw new SandboxSetupError(
			'INVALID_MESSAGE',
			'A turn needs a message of 1 to 20000 characters.',
		);
	}
	const requested = input.role ?? 'auto';
	const routed =
		requested === 'auto'
			? routeRole(
					await routingContext(
						context,
						session,
						paths,
						message,
						await readChat(context.workspaceRoot, session),
					),
				)
			: { role: requested, reason: '' };
	const roleId = routed.role;
	const role = findRole(context.roles, roleId);
	const driverId = input.driver ?? session.driver;
	const driver = await context.registry.resolve(driverId);

	yield await appendChatEntry(context.workspaceRoot, session, {
		kind: 'user',
		role: roleId,
		text: message,
	});

	await updateSession(context.workspaceRoot, session.id, {
		state: 'editing',
		role: roleId,
		driver: driverId,
	});

	if (routed.reason) {
		yield await appendChatEntry(context.workspaceRoot, session, {
			kind: 'system',
			role: roleId,
			text: `Routed to ${role.name}. ${routed.reason}`,
		});
	}

	/* An approved specification produces the module skeleton before the turn
	   starts, so an engineer never has to invent the module layout. */
	const preparation = await scaffoldFromSpec(context, session);
	if (preparation) {
		yield await appendChatEntry(context.workspaceRoot, session, {
			kind: 'system',
			role: roleId,
			text: preparation,
		});
		const install = await installGate(context, session);
		if (install && install.status === 'failed') {
			yield await appendChatEntry(context.workspaceRoot, session, {
				kind: 'system',
				role: roleId,
				text: gateSummary(install),
			});
		}
	}

	const skills = await listSkills(context.workspaceRoot);
	const team = context.roles.filter((mate) => role.handoff.includes(mate.id));
	const instruction = composeInstruction(role, {
		moduleId: session.moduleId,
		modulePath: `modules/${session.moduleSuffix}`,
		sessionKind: session.kind,
		blueprint: session.blueprint,
		allowedPaths: allowedPathsFor(role, session.modules),
		skills,
		team: team.map((mate) => `${mate.id}: ${mate.purpose}`),
		notes: [
			...(session.modules.length > 1
				? [
						`This session changes several modules together: ${session.modules
							.map((module) => `${module.id} (modules/${module.directory})`)
							.join(
								', ',
							)}. Each is a project of this pnpm workspace, so a draft that imports another draft resolves the session copy.`,
					]
				: []),
			'reference/ holds read-only copies of the platform contracts: packages/ for the server, client and UI contracts, example-module/ for a complete module to copy the shape from, auth-core/ for the public authentication surface, and skills/ for the workflows. Read them before implementing and never edit them.',
			'Other module.json files under modules/ describe the dependency graph. Only the draft module directories have sources you may change.',
			...(session.kind === 'edit-module'
				? [
						'The module already exists. Read it before changing it and keep every existing behavior that the request does not ask you to change.',
					]
				: []),
		],
	});
	await writeAgentPointer(
		paths.workspace,
		driverId === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md',
		role.name,
	);

	const history = historyFrom(await readChat(context.workspaceRoot, session));
	const resumeId = session.resumeIds[driverId] ?? null;
	let nextResumeId = resumeId;
	let failed = false;
	let closing = '';

	for await (const event of driver.run({
		workspacePath: paths.workspace,
		role: roleId,
		systemInstruction: instruction,
		prompt: message,
		resumeId,
		history: history.slice(0, -1),
		model: session.model,
		signal: input.signal,
	})) {
		yield await appendChatEntry(context.workspaceRoot, session, {
			kind: eventKind(event),
			role: roleId,
			...(event.type === 'assistant.message' ? { text: event.text } : {}),
			event,
		});
		if (event.type === 'assistant.message') closing = event.text;
		if (event.type === 'turn.completed') {
			nextResumeId = event.resumeId ?? nextResumeId;
			failed = event.finishReason === 'error';
		}
		if (event.type === 'error') failed = true;
	}

	const scaffoldNote = await scaffoldFromSpec(context, session);
	if (scaffoldNote) {
		yield await appendChatEntry(context.workspaceRoot, session, {
			kind: 'system',
			role: roleId,
			text: scaffoldNote,
		});
	}

	/* Prettier is deterministic and not a correctness signal, so the sandbox
	   formats the draft modules itself after each turn rather than bouncing the
	   format gate back to the agent over whitespace. */
	if (!failed) {
		const turnPaths = sessionPaths(
			context.workspaceRoot,
			session.id,
			session.moduleSuffix,
		);
		for (const module of session.modules) {
			await formatDirectory(
				context.workspaceRoot,
				modulePathOf(turnPaths, module.directory),
			);
		}
	}

	const diffs = await collectDiffs(context.workspaceRoot, session);
	const gates: GateResult[] = [];
	if (diffs.length > 0 && !failed) {
		/* The install runs whenever a package.json changed and counts as the
		   dependencies gate; the role's own gates follow, plus the declared
		   dependency check the session cannot do without. */
		const install = await installGate(context, session);
		if (install) gates.push(install);
		if (!install || install.status !== 'failed') {
			gates.push(
				...(await runSessionGates(context, session, [
					...role.gates,
					...(role.gates.includes('dependencies') ? [] : ['dependencies']),
				])),
			);
		}
	}
	for (const gate of gates) {
		yield await appendChatEntry(context.workspaceRoot, session, {
			kind: 'system',
			role: roleId,
			text: gateSummary(gate),
			event: {
				type: gate.status === 'failed' ? 'error' : 'tool.completed',
				...(gate.status === 'failed'
					? {
							code: `GATE_${gate.id.toUpperCase()}`,
							message: gate.output.slice(0, 500),
						}
					: { tool: `gate:${gate.id}`, detail: gate.command, ok: true }),
			} as CodingAgentEvent,
		});
	}

	const declared: HandoffDeclaration | null = closing
		? parseHandoff(closing)
		: null;
	const handoff = planHandoff({
		routing: await routingContext(context, session, paths, message, []),
		role: roleId,
		declared,
		gates,
		failed,
		changed: diffs.length > 0,
		specApproved: await specApproval(session, paths),
		brief: session.brief || message,
	});

	yield await appendChatEntry(context.workspaceRoot, session, {
		kind: 'system',
		role: handoff.role,
		text: handoffText(handoff),
		handoff,
	});

	const updated = await updateSession(context.workspaceRoot, session.id, {
		resumeIds: nextResumeId
			? { ...session.resumeIds, [driverId]: nextResumeId }
			: session.resumeIds,
		state: failed
			? 'failed'
			: handoff.kind === 'approval' || handoff.kind === 'question'
				? 'awaiting-approval'
				: gates.some((gate) => gate.status === 'failed')
					? 'validating'
					: diffs.length > 0
						? 'previewing'
						: 'planned',
		role: roleId,
		driver: driverId,
	});

	if (context.platform && updated.registeredWithPlatform) {
		await context.platform
			.updateSessionState(updated.id, updated.state)
			.catch(() => undefined);
	}

	return { session: updated, diffs, gates, handoff };
}

function eventKind(event: CodingAgentEvent): ChatEntry['kind'] {
	return event.type === 'assistant.message' ? 'agent' : 'event';
}
