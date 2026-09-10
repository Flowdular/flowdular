import { randomUUID } from 'node:crypto';
import {
	access,
	appendFile,
	cp,
	mkdir,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { CodingAgentEvent } from '@flowdular/coding-agent';
import { sandboxDirectory } from './config.ts';
import { materializeModuleGraph, materializeReference } from './reference.ts';
import { hashSpec } from './spec.ts';
import { forgetDiffs } from './turns.ts';
import {
	ensureSessionDependencies,
	materializeSessionWorkspace,
	type InstallResult,
} from './workspace-install.ts';
import { SandboxSetupError } from './workspace-root.ts';

export type SandboxSessionKind = 'new-module' | 'edit-module';

export type SandboxSessionState =
	| 'draft'
	| 'classified'
	| 'planned'
	| 'editing'
	| 'validating'
	| 'previewing'
	| 'awaiting-approval'
	| 'accepted'
	| 'failed'
	| 'blocked'
	| 'deleted';

/* What happens after a turn. The orchestrator writes one of these at the end of
   every turn, so the session always says who continues and why. */
export interface HandoffPlan {
	readonly kind: 'continue' | 'approval' | 'question' | 'review' | 'blocked';
	readonly role: string;
	readonly roleName: string;
	readonly reason: string;
	readonly prompt: string;
	/* The draft module directory the next turn works in. Absent on handoffs
	   written before a session could target one module of several. */
	readonly module?: string;
}

/* One draft module of a session. The directory is the module directory under
   modules/ in both the session workspace and, for an edit, the host
   workspace it was copied from. */
export interface SessionModule {
	readonly id: string;
	readonly directory: string;
	readonly kind: 'new' | 'edit';
	/* When the operator approved this module's specification, and the hash of
	   the exact text they approved. A later edit changes the hash, so the
	   approval belongs to that version of the document and nothing else. */
	readonly specApprovedAt?: number;
	readonly specHash?: string;
}

/* A file the operator attached to the session to show what they want changed.
   The bytes live under the session directory; the same file is copied into the
   workspace so the coding agent, which may only read inside the workspace, can
   open it. `name` is the sanitised filename and doubles as the workspace copy's
   name, so it is unique within the session. */
export interface SessionAttachment {
	readonly id: string;
	readonly name: string;
	readonly kind: 'image' | 'file';
	readonly size: number;
	readonly addedAt: number;
}

/* A restore point the operator can roll the workspace back to. The snapshot of
   each draft module tree lives under checkpoints/<sequence>/; the metadata here
   says which turn produced it. `sequence` is the chat entry it belongs to, so
   the transcript line and its restore point share one identity. */
export interface SessionCheckpoint {
	readonly sequence: number;
	readonly at: number;
	readonly label: string;
	readonly role: string;
}

export interface SandboxSession {
	/* Historical records have no owner. Never infer one from the next login. */
	readonly owner?: SessionOwner;
	readonly rejectedAt?: number | null;
	readonly id: string;
	readonly kind: SandboxSessionKind;
	/* The primary module: modules[0]. Kept as fields for the current UI. */
	readonly moduleId: string;
	readonly moduleSuffix: string;
	readonly modules: readonly SessionModule[];
	readonly title: string;
	/* The request the session started from, replayed to every specialist that
	   picks the work up later. */
	readonly brief: string;
	readonly blueprint: string;
	readonly role: string;
	readonly driver: string;
	readonly model: string | null;
	readonly resumeIds: Readonly<Record<string, string>>;
	/* When true, the orchestrator starts the handed-off turn without waiting for
	   the operator. Approval and failure always stop, whatever this says. */
	readonly autoContinue: boolean;
	/* Automatic turns run since the operator last spoke. */
	readonly chainDepth: number;
	/* Files the operator attached to show the desired change. Bounded per
	   session; see attachments.ts for the limits. */
	readonly attachments: readonly SessionAttachment[];
	/* Restore points, oldest first. Bounded; see checkpoints.ts for the cap and
	   the pruning that never drops the start. */
	readonly checkpoints: readonly SessionCheckpoint[];
	readonly state: SandboxSessionState;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly ejectedAt: number | null;
	readonly archivedAt: number | null;
	readonly registeredWithPlatform: boolean;
}

export interface SessionOwner {
	readonly platformUrl: string;
	readonly tenantId: string;
	readonly accountId: string;
}

export interface ChatEntry {
	readonly decision?: 'approved' | 'changes-requested';
	readonly sequence: number;
	readonly at: number;
	readonly kind: 'user' | 'agent' | 'event' | 'system';
	readonly role: string;
	/* The draft module directory the entry belongs to. Absent on entries that
	   are about the session itself, and on entries written before a session
	   could carry several modules. */
	readonly module?: string;
	readonly text?: string;
	readonly event?: CodingAgentEvent;
	readonly handoff?: HandoffPlan;
	/* Attachments included with this turn, echoed onto the user entry so the
	   transcript records exactly what the agent was shown. */
	readonly attachments?: readonly SessionAttachment[];
}

export interface SessionPaths {
	readonly root: string;
	readonly workspace: string;
	/* The primary module directory. */
	readonly modulePath: string;
	readonly base: string;
	readonly data: string;
	/* Where module-tree snapshots live, one directory per checkpoint sequence. */
	readonly checkpoints: string;
	readonly chatLog: string;
	readonly record: string;
	/* Where attachment bytes are stored, and the workspace copy the coding
	   agent reads from. */
	readonly attachments: string;
	readonly workspaceAttachments: string;
}

const SESSION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSessionId(value: string): boolean {
	return SESSION_ID.test(value);
}

/* Session ids are the only client-chosen segment that reaches the file
   system, so anything that is not an id the sandbox itself minted is refused
   before a path is built from it. */
export function assertSessionId(value: string): string {
	if (!isSessionId(value)) {
		throw new SandboxSetupError(
			'INVALID_SESSION_ID',
			'The session id is not a sandbox session identifier.',
		);
	}
	return value;
}

export function moduleSuffixOf(moduleId: string): string {
	const parts = moduleId.split('.');
	return (parts.at(-1) === 'core' ? parts.slice(0, -1) : parts).join('-');
}

function sessionsRoot(workspaceRoot: string): string {
	return join(sandboxDirectory(workspaceRoot), 'sessions');
}

function sessionRoot(workspaceRoot: string, sessionId: string): string {
	const parent = sessionsRoot(workspaceRoot);
	const root = resolve(parent, sessionId);
	const inside = relative(parent, root);
	if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
		throw new SandboxSetupError(
			'INVALID_SESSION_ID',
			'The session id is not a sandbox session identifier.',
		);
	}
	return root;
}

export function sessionPaths(
	workspaceRoot: string,
	sessionId: string,
	moduleSuffix: string,
): SessionPaths {
	const root = sessionRoot(workspaceRoot, sessionId);
	const workspace = join(root, 'workspace');
	return {
		root,
		workspace,
		modulePath: join(workspace, 'modules', moduleSuffix),
		base: join(root, 'base'),
		data: join(root, 'data'),
		checkpoints: join(root, 'checkpoints'),
		chatLog: join(root, 'chat.jsonl'),
		record: join(root, 'session.json'),
		attachments: join(root, 'attachments'),
		workspaceAttachments: join(workspace, 'reference', 'attachments'),
	};
}

export function modulePathOf(paths: SessionPaths, directory: string): string {
	return join(paths.workspace, 'modules', directory);
}

export function basePathOf(paths: SessionPaths, directory: string): string {
	return join(paths.base, 'modules', directory);
}

export function checkpointModulePath(
	paths: SessionPaths,
	sequence: number,
	directory: string,
): string {
	return join(paths.checkpoints, String(sequence), 'modules', directory);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

const COPY_EXCLUDED = new Set(['node_modules', 'dist', '.turbo']);

export async function copyModuleTree(
	source: string,
	target: string,
): Promise<void> {
	await cp(source, target, {
		recursive: true,
		filter: (path) => {
			const segments = path.split('/');
			return !segments.some((segment) => COPY_EXCLUDED.has(segment));
		},
	});
}

/* A session workspace is a Flowdular workspace of its own: the draft modules,
   the manifests of every other enabled module, the shared TypeScript and
   formatting contracts, and a pnpm workspace that links the live framework
   packages so gates run against the code the platform runs. */
async function prepareSessionWorkspace(options: {
	readonly workspaceRoot: string;
	readonly paths: SessionPaths;
	readonly modules: readonly SessionModule[];
}): Promise<void> {
	await mkdir(join(options.paths.workspace, 'modules'), { recursive: true });
	await mkdir(options.paths.data, { recursive: true });

	const graph = await materializeModuleGraph(
		options.workspaceRoot,
		options.paths.workspace,
		options.modules.map((module) => module.id),
	);
	await materializeReference(options.workspaceRoot, options.paths.workspace);
	await writeFile(
		join(options.paths.workspace, 'flowdular.json'),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				architectureVersion: '0.2.0',
				specs: { platformRoot: 'specs', moduleDirectory: 'spec' },
				modules: {
					roots: ['modules'],
					enabled: [
						...graph,
						...options.modules.map((module) => module.id),
					].sort(),
				},
				locales: ['en', 'pl'],
			},
			null,
			'\t',
		)}\n`,
		'utf8',
	);
	for (const shared of ['tsconfig.base.json', '.prettierrc.json']) {
		await cp(
			join(options.workspaceRoot, shared),
			join(options.paths.workspace, shared),
		).catch(() => undefined);
	}
	await mkdir(join(options.paths.workspace, 'specs'), { recursive: true });
	await materializeSessionWorkspace({
		workspaceRoot: options.workspaceRoot,
		sessionWorkspace: options.paths.workspace,
		modules: options.modules,
	});
}

/* Installs the draft modules' dependencies when they changed. The result is
   what the caller reports: a failed install is a gate failure the agent has to
   see, not a silent typecheck error. */
export function installSessionDependencies(
	workspaceRoot: string,
	session: SandboxSession,
	force = false,
): Promise<InstallResult> {
	const paths = sessionPaths(workspaceRoot, session.id, session.moduleSuffix);
	return ensureSessionDependencies({
		sessionRoot: paths.root,
		sessionWorkspace: paths.workspace,
		modules: session.modules,
		force,
	});
}

export interface CreateSessionInput {
	readonly owner?: SessionOwner;
	readonly workspaceRoot: string;
	readonly kind: SandboxSessionKind;
	readonly moduleId: string;
	readonly title: string;
	readonly brief: string;
	readonly blueprint: string;
	readonly role: string;
	readonly driver: string;
	readonly model?: string | null;
	/* Module directory name inside the workspace, for an edit session. */
	readonly sourceModule?: string;
	/* Every module of the session; the first one is primary. Defaults to the
	   single module named by moduleId. */
	readonly modules?: readonly SessionModule[];
	/* Run the dependency install right away. The routes run it themselves so
	   they can report a failure into the transcript. */
	readonly install?: boolean;
}

const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const MODULE_DIRECTORY = /^[a-z][a-z0-9-]*$/;

function assertModule(module: SessionModule): void {
	if (!MODULE_ID.test(module.id)) {
		throw new SandboxSetupError(
			'INVALID_MODULE_ID',
			'Module id must use lowercase dot-separated segments, for example sales.orders.',
		);
	}
	if (!MODULE_DIRECTORY.test(module.directory)) {
		throw new SandboxSetupError(
			'INVALID_MODULE_ID',
			`Module directory ${module.directory} is not a module directory name.`,
		);
	}
}

export async function createSession(
	input: CreateSessionInput,
): Promise<SandboxSession> {
	const moduleSuffix = moduleSuffixOf(input.moduleId);
	const modules: readonly SessionModule[] = input.modules ?? [
		{
			id: input.moduleId,
			directory:
				input.kind === 'edit-module'
					? (input.sourceModule ?? moduleSuffix)
					: moduleSuffix,
			kind: input.kind === 'edit-module' ? 'edit' : 'new',
		},
	];
	if (modules.length === 0 || modules[0]!.id !== input.moduleId) {
		throw new SandboxSetupError(
			'INVALID_MODULE_ID',
			'The primary module must be the first module of the session.',
		);
	}
	for (const module of modules) assertModule(module);
	const primaryDirectory = modules[0]!.directory;
	const id = randomUUID();
	const paths = sessionPaths(input.workspaceRoot, id, primaryDirectory);

	for (const module of modules) {
		const target = modulePathOf(paths, module.directory);
		const base = basePathOf(paths, module.directory);
		if (module.kind === 'edit') {
			const source = join(input.workspaceRoot, 'modules', module.directory);
			await copyModuleTree(source, target);
			await copyModuleTree(source, base);
		} else {
			await mkdir(target, { recursive: true });
			await mkdir(base, { recursive: true });
		}
	}

	await prepareSessionWorkspace({
		workspaceRoot: input.workspaceRoot,
		paths,
		modules,
	});

	/* The pristine state is the first restore point, so an operator can always
	   roll back to before any agent touched the module. */
	for (const module of modules) {
		await copyModuleTree(
			modulePathOf(paths, module.directory),
			checkpointModulePath(paths, 0, module.directory),
		);
	}

	const now = Date.now();
	const session: SandboxSession = {
		...(input.owner ? { owner: input.owner } : {}),
		id,
		kind: input.kind,
		moduleId: input.moduleId,
		moduleSuffix: primaryDirectory,
		modules,
		title: input.title,
		brief: input.brief,
		blueprint: input.blueprint,
		role: input.role,
		driver: input.driver,
		model: input.model ?? null,
		resumeIds: {},
		autoContinue: true,
		chainDepth: 0,
		attachments: [],
		checkpoints: [
			{ sequence: 0, at: now, label: 'the starting point', role: input.role },
		],
		state: 'draft',
		createdAt: now,
		updatedAt: now,
		ejectedAt: null,
		archivedAt: null,
		registeredWithPlatform: false,
	};
	await writeSession(input.workspaceRoot, session);
	if (input.install === true) {
		await installSessionDependencies(input.workspaceRoot, session);
	}
	return session;
}

/* A module joins a session after it started: it is materialized into the
   workspace (with its pristine base, for an edit), appended to modules[], and
   the workspace manifests are regenerated so the new draft is a project of the
   session's pnpm workspace instead of a link to the host checkout. The caller
   installs afterwards; the install only runs when the new package.json changed
   the session's dependency signature. */
export async function addSessionModule(
	workspaceRoot: string,
	session: SandboxSession,
	module: SessionModule,
): Promise<SandboxSession> {
	assertModule(module);
	if (
		session.modules.some(
			(entry) => entry.id === module.id || entry.directory === module.directory,
		)
	) {
		throw new SandboxSetupError(
			'MODULE_ALREADY_IN_SESSION',
			`${module.id} is already part of this session.`,
		);
	}
	const paths = sessionPaths(workspaceRoot, session.id, session.moduleSuffix);
	const target = modulePathOf(paths, module.directory);
	const base = basePathOf(paths, module.directory);
	if (module.kind === 'edit') {
		const source = join(workspaceRoot, 'modules', module.directory);
		await copyModuleTree(source, target);
		await copyModuleTree(source, base);
	} else {
		await mkdir(target, { recursive: true });
		await mkdir(base, { recursive: true });
	}
	const modules = [...session.modules, module];
	await prepareSessionWorkspace({ workspaceRoot, paths, modules });
	return updateSession(workspaceRoot, session.id, {
		modules,
		moduleId: modules[0]!.id,
		moduleSuffix: modules[0]!.directory,
	});
}

/* The record is replaced by rename, so a reader racing a running turn never
   sees a half-written file. */
export async function writeSession(
	workspaceRoot: string,
	session: SandboxSession,
): Promise<SandboxSession> {
	const paths = sessionPaths(workspaceRoot, session.id, session.moduleSuffix);
	await mkdir(paths.root, { recursive: true });
	const staging = `${paths.record}.${process.pid}.${randomUUID().slice(0, 8)}`;
	await writeFile(staging, `${JSON.stringify(session, null, '\t')}\n`, 'utf8');
	await rename(staging, paths.record);
	return session;
}

export async function readSession(
	workspaceRoot: string,
	sessionId: string,
): Promise<SandboxSession> {
	const root = sessionRoot(workspaceRoot, assertSessionId(sessionId));
	try {
		const record = JSON.parse(
			await readFile(join(root, 'session.json'), 'utf8'),
		) as SandboxSession;
		/* Sessions written before a field existed stay readable, so an older
		   session opens instead of disappearing from the list. */
		return {
			...record,
			brief: record.brief ?? '',
			modules: record.modules ?? [
				{
					id: record.moduleId,
					directory: record.moduleSuffix,
					kind: record.kind === 'edit-module' ? 'edit' : 'new',
				},
			],
			autoContinue: record.autoContinue !== false,
			chainDepth: record.chainDepth ?? 0,
			attachments: record.attachments ?? [],
			checkpoints: record.checkpoints ?? [],
			ejectedAt: record.ejectedAt ?? null,
			archivedAt: record.archivedAt ?? null,
		};
	} catch (error) {
		if (error instanceof SandboxSetupError) throw error;
		throw new SandboxSetupError(
			'SESSION_NOT_FOUND',
			`No sandbox session ${sessionId} exists in this workspace.`,
		);
	}
}

/* Every session that still has a record, archived ones included, so the
   client decides what to show. Deleted sessions are tombstones kept for their
   transcript and never listed. */
export async function listSessions(
	workspaceRoot: string,
	includeDeleted = false,
): Promise<readonly SandboxSession[]> {
	let entries: readonly string[];
	try {
		entries = await readdir(sessionsRoot(workspaceRoot));
	} catch {
		return [];
	}
	const sessions: SandboxSession[] = [];
	for (const entry of entries) {
		if (!isSessionId(entry)) continue;
		try {
			const session = await readSession(workspaceRoot, entry);
			if (includeDeleted || session.state !== 'deleted') sessions.push(session);
		} catch {
			continue;
		}
	}
	return sessions.sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function updateSession(
	workspaceRoot: string,
	sessionId: string,
	patch: Partial<Omit<SandboxSession, 'id' | 'createdAt'>>,
): Promise<SandboxSession> {
	const current = await readSession(workspaceRoot, sessionId);
	return writeSession(workspaceRoot, {
		...current,
		...patch,
		updatedAt: Date.now(),
	});
}

export function archiveSession(
	workspaceRoot: string,
	sessionId: string,
): Promise<SandboxSession> {
	return updateSession(workspaceRoot, sessionId, { archivedAt: Date.now() });
}

export function restoreSession(
	workspaceRoot: string,
	sessionId: string,
): Promise<SandboxSession> {
	return updateSession(workspaceRoot, sessionId, {
		archivedAt: null,
		rejectedAt: null,
	});
}

/* Replaces a draft module directory with a checkpoint snapshot: the current
   contents step aside, then the snapshot is copied over the emptied directory.
   node_modules stays so the session's install survives the rollback. */
async function replaceModuleContents(
	target: string,
	snapshot: string,
): Promise<void> {
	await mkdir(target, { recursive: true });
	for (const entry of await readdir(target)) {
		if (entry === 'node_modules') continue;
		await rm(join(target, entry), { recursive: true, force: true });
	}
	await copyModuleTree(snapshot, target);
}

/* Rolls the session workspace back to a captured checkpoint. The transcript is
   append-only: the rollback is recorded as a marker, never by rewriting the
   history, so the record of what the agents did stays intact. */
export async function restoreCheckpoint(
	workspaceRoot: string,
	sessionId: string,
	sequence: number,
): Promise<SandboxSession> {
	const session = await readSession(workspaceRoot, assertSessionId(sessionId));
	const checkpoint = session.checkpoints.find(
		(entry) => entry.sequence === sequence,
	);
	if (!checkpoint) {
		throw new SandboxSetupError(
			'CHECKPOINT_NOT_FOUND',
			`No checkpoint for turn ${sequence} exists in this session.`,
		);
	}
	const paths = sessionPaths(workspaceRoot, session.id, session.moduleSuffix);
	for (const module of session.modules) {
		const snapshot = checkpointModulePath(paths, sequence, module.directory);
		/* A checkpoint older than the module says nothing about it, so that
		   module keeps its current files instead of failing the rollback. */
		if (!(await exists(snapshot))) continue;
		await replaceModuleContents(
			modulePathOf(paths, module.directory),
			snapshot,
		);
	}
	forgetDiffs(session.id);
	await appendChatEntry(workspaceRoot, session, {
		kind: 'system',
		role: checkpoint.role,
		text: `Restored the workspace to the state after ${checkpoint.label} (turn ${sequence}).`,
	});
	return updateSession(workspaceRoot, session.id, { state: 'editing' });
}

export interface DeleteSessionOptions {
	/* Keep session.json and chat.jsonl as a tombstone. Default true. */
	readonly keepTranscript?: boolean;
}

/* Deleting removes what the session materialized: the workspace, the base
   copy and the ephemeral data. The record and the transcript stay by default,
   because they are the evidence of what the agents did. */
export async function deleteSession(
	workspaceRoot: string,
	sessionId: string,
	options: DeleteSessionOptions = {},
): Promise<void> {
	const session = await readSession(workspaceRoot, sessionId);
	const paths = sessionPaths(workspaceRoot, session.id, session.moduleSuffix);
	/* A symlink planted inside the sessions directory must not turn the
	   removal into one outside it. */
	const canonicalParent = await realpath(sessionsRoot(workspaceRoot));
	const canonicalRoot = await realpath(paths.root);
	const inside = relative(canonicalParent, canonicalRoot);
	if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
		throw new SandboxSetupError(
			'INVALID_SESSION_ID',
			'The session directory is not inside the sandbox sessions directory.',
		);
	}
	lastSequence.delete(session.id);
	if (options.keepTranscript === false) {
		await rm(paths.root, { recursive: true, force: true });
		return;
	}
	for (const directory of [
		paths.workspace,
		paths.base,
		paths.data,
		paths.attachments,
		paths.checkpoints,
	]) {
		await rm(directory, { recursive: true, force: true });
	}
	await writeSession(workspaceRoot, {
		...session,
		state: 'deleted',
		updatedAt: Date.now(),
	});
}

/* Approving a draft specification is a one-line, reviewable edit: only the
   status field moves, so the operator's decision cannot rewrite the document.
   The hash of the approved text is recorded on the module, which is what makes
   the approval belong to this version of the specification and not to the file
   name: an edit after it re-opens the gate. */
export async function approveSpecification(
	workspaceRoot: string,
	session: SandboxSession,
	module: SessionModule = session.modules[0]!,
): Promise<{
	readonly session: SandboxSession;
	readonly status: string;
	readonly module: string;
}> {
	const paths = sessionPaths(workspaceRoot, session.id, session.moduleSuffix);
	const specPath = join(
		modulePathOf(paths, module.directory),
		'spec',
		'module.yaml',
	);
	let spec: string;
	try {
		spec = await readFile(specPath, 'utf8');
	} catch {
		throw new SandboxSetupError(
			'SPEC_NOT_FOUND',
			`${module.id} has no specification to approve yet.`,
		);
	}
	const status = /^status:[ \t]*(\S+)[ \t]*$/m.exec(spec);
	if (!status) {
		throw new SandboxSetupError(
			'SPEC_STATUS_MISSING',
			'The specification has no status field, so it cannot be approved.',
		);
	}
	if (status[1] !== 'approved') {
		spec = spec.replace(/^status:[ \t]*\S+[ \t]*$/m, 'status: approved');
		await writeFile(specPath, spec, 'utf8');
	}
	const approvedAt = Date.now();
	const specHash = hashSpec(spec);
	const current = await readSession(workspaceRoot, session.id);
	return {
		session: await updateSession(workspaceRoot, session.id, {
			modules: current.modules.map((entry) =>
				entry.directory === module.directory
					? { ...entry, specApprovedAt: approvedAt, specHash }
					: entry,
			),
			state: 'planned',
		}),
		status: 'approved',
		module: module.directory,
	};
}

/* The module a request names, by directory or by id. A name the session does
   not have is refused rather than silently redirected to the primary module,
   because everything downstream builds a path from it. */
export function findSessionModule(
	session: SandboxSession,
	requested: string | null | undefined,
): SessionModule {
	if (!requested) return session.modules[0]!;
	const found = session.modules.find(
		(module) => module.directory === requested || module.id === requested,
	);
	if (!found) {
		throw new SandboxSetupError(
			'MODULE_NOT_IN_SESSION',
			`This session has no module ${requested}. Add it to the session first.`,
		);
	}
	return found;
}

/* The next sequence per session, so an append does not re-read the whole
   transcript. Bounded: the map only holds sessions this process appended to. */
const lastSequence = new Map<string, number>();
const SEQUENCE_CACHE_LIMIT = 256;

export async function appendChatEntry(
	workspaceRoot: string,
	session: SandboxSession,
	entry: Omit<ChatEntry, 'sequence' | 'at'>,
): Promise<ChatEntry> {
	const paths = sessionPaths(workspaceRoot, session.id, session.moduleSuffix);
	let previous = lastSequence.get(session.id);
	if (previous === undefined) {
		previous = (await readChat(workspaceRoot, session)).at(-1)?.sequence ?? 0;
		if (lastSequence.size >= SEQUENCE_CACHE_LIMIT) {
			lastSequence.delete(lastSequence.keys().next().value!);
		}
	}
	const record: ChatEntry = {
		...entry,
		sequence: previous + 1,
		at: Date.now(),
	};
	lastSequence.set(session.id, record.sequence);
	await appendFile(paths.chatLog, `${JSON.stringify(record)}\n`, 'utf8');
	return record;
}

export async function readChat(
	workspaceRoot: string,
	session: SandboxSession,
	after = 0,
): Promise<readonly ChatEntry[]> {
	const paths = sessionPaths(workspaceRoot, session.id, session.moduleSuffix);
	let raw: string;
	try {
		raw = await readFile(paths.chatLog, 'utf8');
	} catch {
		return [];
	}
	const entries: ChatEntry[] = [];
	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as ChatEntry;
			if (entry.sequence > after) entries.push(entry);
		} catch {
			continue;
		}
	}
	return entries;
}
