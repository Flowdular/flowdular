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
	selectTaskSkill,
	type AgentRoleDefinition,
	type CodingAgentEvent,
	type CodingAgentMessage,
	type CodingAgentRegistry,
	type HandoffDeclaration,
} from '@flowdular/coding-agent';
import {
	invalidateAutoReview,
	prepareAutoReview,
	moduleReviewRevision,
	recordAutoReview,
} from './auto-review.ts';
import {
	attachmentInstruction,
	materializeAttachments,
} from './attachments.ts';
import { captureCheckpoint } from './checkpoints.ts';
import { guardAgentPaths } from './path-guard.ts';
import type { SandboxConfiguration } from './config.ts';
import { diffTrees, type FileDiff } from './diff.ts';
import {
	GATE_IDS,
	formatDirectory,
	isGateId,
	runGates,
	type GateId,
	type GateResult,
} from './gates.ts';
import {
	SPEC_OWNER_ROLE,
	planHandoff,
	planSpecGateHandoff,
	routeRole,
	type RoutingContext,
} from './planning.ts';
import type { PlatformClient } from './platform-client.ts';
import { listSkills, writeAgentPointer } from './reference.ts';
import {
	appendChatEntry,
	basePathOf,
	findSessionModule,
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
import { isSpecApproved, readSpecGate, type SpecGate } from './spec.ts';
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
	/* Runs deterministic sandbox gates. Tests may replace the process boundary
	   while keeping routing and approval behaviour unchanged. */
	readonly executeGates?: (input: {
		readonly session: SandboxSession;
		readonly gates: readonly GateId[];
		readonly modules?: readonly SessionModule[];
	}) => Promise<readonly GateResult[]>;
}

export interface TurnInput {
	readonly freshContext?: boolean;
	readonly sessionId: string;
	readonly message: string;
	readonly role?: string;
	/* The draft module directory this turn works in. Defaults to the module the
	   last handoff named, then to the primary module. */
	readonly module?: string;
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
	modulePath: string,
	message: string,
	entries: readonly ChatEntry[],
	specApproved: boolean | null,
): Promise<RoutingContext> {
	return {
		session,
		paths,
		roles: context.roles,
		message,
		hasSpec: await exists(join(modulePath, 'spec/module.yaml')),
		hasManifest: await exists(join(modulePath, 'module.json')),
		hasServer: await hasServerSurface(modulePath),
		hasClient: await exists(join(modulePath, 'src/client/contribution.tsrx')),
		specApproved,
		lastHandoff:
			entries.filter((entry) => entry.handoff).at(-1)?.handoff ?? null,
	};
}

/* The last handoff names the module the work continues in, so a chained turn
   stays where the previous one left off. An explicit request wins, and one that
   names a module the session does not have is refused rather than silently
   redirected to the primary. */
function activeModule(
	session: SandboxSession,
	requested: string | undefined,
	entries: readonly ChatEntry[],
): SessionModule {
	if (requested) return findSessionModule(session, requested);
	const named = entries.filter((entry) => entry.handoff).at(-1)
		?.handoff?.module;
	return (
		session.modules.find((module) => module.directory === named) ??
		session.modules[0]!
	);
}

/* Nobody but the specification owner works in a module whose specification the
   operator has not approved. A missing owner role is a configuration error, not
   permission to bypass the gate. */
function refusesUnapproved(gate: SpecGate, roleId: string): boolean {
	return gate.approved !== true && roleId !== SPEC_OWNER_ROLE;
}

/* The refused turn: the operator hears why nothing ran, with a stable code, and
   the session stops on the move that unblocks it. */
async function* refuseUnapproved(
	context: TurnContext,
	session: SandboxSession,
	active: SessionModule,
	role: AgentRoleDefinition,
	gate: SpecGate,
	input: { readonly brief: string; readonly driver: string },
): AsyncGenerator<ChatEntry, TurnOutcome> {
	const handoff = planSpecGateHandoff({
		roles: context.roles,
		module: active.directory,
		refusedRole: role.id,
		changed: gate.changed,
		brief: input.brief,
	});
	const reason = `${role.name} did not take this turn: the specification of ${active.id} is not approved. ${
		gate.changed
			? 'Review the change below and approve it, ask for changes, or edit the specification yourself.'
			: `${handoff.roleName} writes the specification change first.`
	}`;
	yield await appendChatEntry(context.workspaceRoot, session, {
		kind: 'system',
		role: role.id,
		module: active.directory,
		text: reason,
		event: {
			type: 'error',
			code: 'SPEC_NOT_APPROVED',
			message: reason,
		} as CodingAgentEvent,
	});
	yield await appendChatEntry(context.workspaceRoot, session, {
		kind: 'system',
		role: handoff.role,
		module: active.directory,
		text: handoffText(handoff),
		handoff,
	});
	const updated = await updateSession(context.workspaceRoot, session.id, {
		state: handoff.kind === 'approval' ? 'awaiting-approval' : 'planned',
		driver: input.driver,
	});
	return {
		session: updated,
		diffs: await collectDiffs(context.workspaceRoot, updated),
		gates: [],
		handoff,
	};
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
			['--dir', workspaceRoot, '--silent', 'flowdular', ...args],
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
	const stash = await mkdtemp(join(tmpdir(), 'flowdular-scaffold-'));
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
		if (!isSpecApproved(module, spec)) {
			notes.push(
				`The ${module.id} specification is not approved by the operator yet, so the module skeleton was not created.`,
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
	modules?: readonly SessionModule[],
	signal?: AbortSignal,
): Promise<readonly GateResult[]> {
	const selected = gates.filter(isGateId) as GateId[];
	if (selected.length === 0) return [];
	if (context.executeGates) {
		return context.executeGates({
			session,
			gates: selected,
			...(modules ? { modules } : {}),
		});
	}
	return runGates({
		workspaceRoot: context.workspaceRoot,
		paths: sessionPaths(
			context.workspaceRoot,
			session.id,
			session.moduleSuffix,
		),
		session,
		gates: selected,
		...(modules ? { modules } : {}),
		...(signal ? { signal } : {}),
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

/* A turn writes in one module, so the role's paths resolve against that
   module's directory and nowhere else. */
function allowedPathsFor(
	role: AgentRoleDefinition,
	module: SessionModule,
): readonly string[] {
	return role.allowedPaths.map((path) => `modules/${module.directory}/${path}`);
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
	let session = await readSession(context.workspaceRoot, input.sessionId);
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
	const transcript = await readChat(context.workspaceRoot, session);
	const active = activeModule(session, input.module, transcript);
	const modulePath = modulePathOf(paths, active.directory);
	const gate = await readSpecGate(
		active,
		modulePath,
		basePathOf(paths, active.directory),
	);
	const requested = input.role ?? 'auto';
	const routed =
		requested === 'auto'
			? routeRole(
					await routingContext(
						context,
						session,
						paths,
						modulePath,
						message,
						transcript,
						gate.approved,
					),
				)
			: { role: requested, reason: '' };
	const roleId = routed.role;
	const role = findRole(context.roles, roleId);
	const driverId = input.driver ?? session.driver;
	const driver = await context.registry.resolve(driverId);

	session = {
		...session,
		attachments: await materializeAttachments(context.workspaceRoot, session),
	};
	const attachmentNote = attachmentInstruction(session.attachments);

	yield await appendChatEntry(context.workspaceRoot, session, {
		kind: 'user',
		role: roleId,
		module: active.directory,
		text: message,
		...(session.attachments.length > 0
			? { attachments: session.attachments }
			: {}),
	});

	if (refusesUnapproved(gate, roleId)) {
		return yield* refuseUnapproved(context, session, active, role, gate, {
			brief: session.brief || message,
			driver: driverId,
		});
	}

	await updateSession(context.workspaceRoot, session.id, {
		state: 'editing',
		role: roleId,
		driver: driverId,
	});

	if (routed.reason) {
		yield await appendChatEntry(context.workspaceRoot, session, {
			kind: 'system',
			role: roleId,
			module: active.directory,
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

	const skill = selectTaskSkill({
		role: role.id,
		sessionKind: active.kind === 'new' ? 'new-module' : 'edit-module',
		blueprint: session.blueprint,
		task: message,
		available: await listSkills(context.workspaceRoot),
	});
	const reviewing = skill === 'auto-review';
	if (reviewing) await prepareAutoReview(context.workspaceRoot, paths, active);
	const reviewRevision = reviewing
		? await moduleReviewRevision(modulePath)
		: null;
	if (reviewing) await invalidateAutoReview(paths, active);
	let reviewPassed = false;
	const turnAllowedPaths = reviewing ? [] : allowedPathsFor(role, active);
	const team = context.roles.filter((mate) => role.handoff.includes(mate.id));
	const instruction = composeInstruction(role, {
		moduleId: active.id,
		modulePath: `modules/${active.directory}`,
		sessionKind: active.kind === 'new' ? 'new-module' : 'edit-module',
		blueprint: session.blueprint,
		allowedPaths: turnAllowedPaths,
		skill,
		team: team.map((mate) => `${mate.id}: ${mate.purpose}`),
		notes: [
			...(reviewing
				? [
						'Read the complete active-module change against reference/auto-review-base/. This turn is read-only. Preserve the intended next-specialist handoff from the implementation turn after a passing review.',
					]
				: []),
			...(session.modules.length > 1
				? [
						`This session works on several modules: ${session.modules
							.map(
								(module) =>
									`${module.id} (modules/${module.directory}, ${module.kind === 'new' ? 'new' : 'existing'})`,
							)
							.join(
								', ',
							)}. This turn is yours in modules/${active.directory} only; another specialist takes the turn for the others. Each module is a project of this pnpm workspace, so a draft that imports another draft resolves the session copy.`,
					]
				: []),
			'reference/ is read-only. Consult only the code and references needed for this task; do not preload its catalog.',
			'Other module.json files under modules/ describe the dependency graph. Only the draft module directories have sources you may change.',
			...(active.kind === 'edit'
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
		skill,
	);

	const history = historyFrom(await readChat(context.workspaceRoot, session));
	// Provider conversations retain instructions and tool history. Reuse one only
	// while its role, module, skill, write ceiling, specification and model match.
	const resumePrefix = `${driverId}:scope:`;
	const resumeKey =
		resumePrefix +
		createHash('sha256')
			.update(
				JSON.stringify([
					instruction,
					active.specHash ?? null,
					session.model ?? context.configuration.driverModel,
				]),
			)
			.digest('hex');
	const previousKeys = Object.keys(session.resumeIds).filter(
		(key) => key === driverId || key.startsWith(resumePrefix),
	);
	const resumeId = input.freshContext
		? null
		: (session.resumeIds[resumeKey] ?? null);
	if (input.freshContext || (!resumeId && previousKeys.length > 0)) {
		yield await appendChatEntry(context.workspaceRoot, session, {
			kind: 'system',
			role: roleId,
			text: `Starting fresh agent context for ${role.name} in ${active.id} with the current task and write scope. Draft files, approved specification and sandbox history are preserved; the agent receives the brief and recent messages.`,
		});
	}
	let nextResumeId = resumeId;
	let failed = false;
	let closing = '';
	/* This snapshot is the enforcement point for role ownership. The workspace
	   remains readable to the agent, but changes outside its module allowlist are
	   quarantined and restored before any formatter, gate, checkpoint or delivery
	   can observe them. */
	const pathGuard = await guardAgentPaths({
		workspace: paths.workspace,
		sessionRoot: paths.root,
		allowedPaths: turnAllowedPaths,
	});

	try {
		for await (const event of driver.run({
			workspacePath: paths.workspace,
			allowedPaths: turnAllowedPaths,
			role: roleId,
			systemInstruction: instruction,
			prompt: attachmentNote ? `${attachmentNote}\n\n${message}` : message,
			resumeId,
			history: [{ role: 'user', text: session.brief }, ...history.slice(0, -1)],
			model: session.model,
			signal: input.signal,
		})) {
			yield await appendChatEntry(context.workspaceRoot, session, {
				kind: eventKind(event),
				role: roleId,
				module: active.directory,
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
	} catch (error) {
		failed = true;
		yield await appendChatEntry(context.workspaceRoot, session, {
			kind: 'system',
			role: roleId,
			module: active.directory,
			text:
				error instanceof Error
					? `The coding agent stopped: ${error.message}`
					: 'The coding agent stopped unexpectedly.',
			event: {
				type: 'error',
				code: 'AGENT_TURN_FAILED',
				message: 'The coding agent stopped unexpectedly.',
			} as CodingAgentEvent,
		});
	}

	const pathResult = await pathGuard.verify();
	if (pathResult.violations.length > 0) {
		failed = true;
		const evidence = pathResult.violations
			.map((violation) => `- ${violation.path}: ${violation.reason}`)
			.join('\n');
		yield await appendChatEntry(context.workspaceRoot, session, {
			kind: 'system',
			role: roleId,
			module: active.directory,
			text: `This turn wrote outside its allowed paths and was failed. The sandbox restored those paths before validation.\n${evidence}${pathResult.quarantine ? `\nEvidence was quarantined at ${pathResult.quarantine}.` : ''}`,
			event: {
				type: 'error',
				code: 'ALLOWED_PATHS_VIOLATION',
				message: evidence.slice(0, 500),
			} as CodingAgentEvent,
		});
	}

	const scaffoldNote =
		failed || reviewing ? null : await scaffoldFromSpec(context, session);
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
	if (!failed && !reviewing) {
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
	if ((diffs.length > 0 || reviewing) && !failed) {
		/* Only the modules that hold changes are gated: a module nobody touched
		   has nothing to check and its gates would cost minutes for no signal. */
		const changed = new Set(diffs.map((diff) => diff.module));
		const gated = session.modules.filter((module) =>
			changed.has(module.directory),
		);
		/* The install runs whenever a package.json changed and counts as the
		   dependencies gate; the role's own gates follow, plus the declared
		   dependency check the session cannot do without. */
		const install = await installGate(context, session);
		if (install) gates.push(install);
		if (!install || install.status !== 'failed') {
			gates.push(
				...(await runSessionGates(
					context,
					session,
					[
						...(reviewing
							? GATE_IDS.filter((id) => id !== 'auto-review')
							: role.gates),
						...(role.gates.includes('dependencies') ? [] : ['dependencies']),
					],
					reviewing ? [active] : gated,
					input.signal,
				)),
			);
		}
	}
	if (
		reviewing &&
		!failed &&
		!input.signal?.aborted &&
		reviewRevision !== null
	) {
		const verified = GATE_IDS.filter((id) => id !== 'auto-review').every((id) =>
			gates.some(
				(gate) =>
					gate.id === id &&
					gate.status === 'passed' &&
					(gate.module === active.directory ||
						((id === 'spec-schema' || id === 'module-schema') &&
							gate.module === undefined)),
			),
		);
		if (verified && gates.every((gate) => gate.status === 'passed')) {
			reviewPassed = await recordAutoReview(
				paths,
				active,
				reviewRevision,
				closing,
			);
		}
		gates.push(
			...(await runSessionGates(
				context,
				session,
				['auto-review'],
				[active],
				input.signal,
			)),
		);
	}

	if (reviewing && !reviewPassed && !failed) {
		const index = gates.findIndex(
			(gate) => gate.id === 'auto-review' && gate.status === 'failed',
		);
		if (index >= 0 && /"verdict"\s*:\s*"fail"/.test(closing)) {
			gates[index] = {
				...gates[index]!,
				output:
					'Use $module-update to fix the findings in your preceding review. Preserve unrelated behavior, add regression tests, and finish implementation before requesting another review.',
			};
		}
	}
	const declared: HandoffDeclaration | null = closing
		? parseHandoff(closing)
		: null;
	/* The turn may have written the specification, so the gate is read again:
	   what the next role may do depends on the document as it is now. */
	const closingGate = await readSpecGate(
		active,
		modulePath,
		basePathOf(paths, active.directory),
	);
	const handoffContext = {
		routing: await routingContext(
			context,
			session,
			paths,
			modulePath,
			message,
			[],
			closingGate.approved,
		),
		role: roleId,
		module: active.directory,
		declared,
		gates,
		failed,
		changed: diffs.length > 0,
		specApproved: closingGate.approved,
		brief: session.brief || message,
		reviewing,
	};
	let handoff = planHandoff(handoffContext);
	if (handoff.kind === 'review') {
		// Let intermediate specialists finish their handoffs before a full review.
		// Every delivered module, including unchanged drafts, needs a current record.
		const remaining = session.modules.filter(
			(module) =>
				!gates.some(
					(gate) =>
						gate.id === 'auto-review' && gate.module === module.directory,
				),
		);
		if (remaining.length > 0) {
			gates.push(
				...(await runSessionGates(
					context,
					session,
					['auto-review'],
					remaining,
					input.signal,
				)),
			);
			handoff = planHandoff(handoffContext);
		}
	}

	for (const gate of gates) {
		yield await appendChatEntry(context.workspaceRoot, session, {
			kind: 'system',
			role: roleId,
			...(gate.module ? { module: gate.module } : {}),
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

	const handoffEntry = await appendChatEntry(context.workspaceRoot, session, {
		kind: 'system',
		role: handoff.role,
		...(handoff.module ? { module: handoff.module } : {}),
		text: handoffText(handoff),
		handoff,
	});
	yield handoffEntry;

	/* A turn that changed files becomes a restore point, keyed by the handoff
	   entry so the transcript line and its checkpoint share one sequence. */
	if (diffs.length > 0) {
		await captureCheckpoint(
			context.workspaceRoot,
			session,
			handoffEntry.sequence,
			{ label: role.name, role: roleId },
		);
	}

	const resumeIds = { ...session.resumeIds };
	// Retain at most one conversation per driver, including after many handoffs.
	for (const key of previousKeys) delete resumeIds[key];
	if (nextResumeId) resumeIds[resumeKey] = nextResumeId;
	const updated = await updateSession(context.workspaceRoot, session.id, {
		resumeIds,
		state: failed
			? 'failed'
			: handoff.kind === 'approval' || handoff.kind === 'question'
				? 'awaiting-approval'
				: gates.some((gate) => gate.status !== 'passed')
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
