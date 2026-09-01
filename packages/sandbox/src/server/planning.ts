import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
	AgentRoleDefinition,
	CodingAgentRegistry,
	HandoffDeclaration,
} from '@coreloom/coding-agent';
import type { GateResult } from './gates.ts';
import { SandboxSetupError } from './workspace-root.ts';
import {
	moduleSuffixOf,
	type HandoffPlan,
	type SandboxSession,
	type SessionModule,
	type SessionPaths,
} from './sessions.ts';

export interface WorkspaceModule {
	readonly id: string;
	readonly directory: string;
	readonly name: string;
}

export interface WorkPlan {
	readonly kind: 'new-module' | 'edit-module';
	/* The primary module: modules[0]. */
	readonly moduleId: string;
	readonly title: string;
	readonly sourceModule: string | null;
	/* Every module the work touches, primary first. A known id is a change to
	   that module; an unknown id is a new module. */
	readonly modules: readonly SessionModule[];
	readonly firstRole: string;
	readonly rationale: string;
	readonly classifiedBy: 'agent' | 'rules';
}

const PLAN_TIMEOUT_MS = 3 * 60 * 1000;
const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
/* Bounded output for the fix prompt; the transcript keeps the whole output. */
const GATE_PROMPT_OUTPUT = 4_000;

export async function listWorkspaceModules(
	workspaceRoot: string,
): Promise<readonly WorkspaceModule[]> {
	let entries: readonly string[] = [];
	try {
		entries = await readdir(join(workspaceRoot, 'modules'));
	} catch {
		return [];
	}
	const modules: WorkspaceModule[] = [];
	for (const entry of entries) {
		try {
			const manifest = JSON.parse(
				await readFile(
					join(workspaceRoot, 'modules', entry, 'module.json'),
					'utf8',
				),
			) as { id?: string };
			if (manifest.id) {
				modules.push({ id: manifest.id, directory: entry, name: entry });
			}
		} catch {
			continue;
		}
	}
	return modules;
}

function slugTitle(brief: string): string {
	const words = brief
		.replace(/[^a-zA-Z0-9 ]/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 4);
	return words.length > 0 ? words.join(' ') : 'Module session';
}

const FILLER = new Set([
	'module',
	'should',
	'would',
	'could',
	'their',
	'there',
	'these',
	'those',
	'about',
	'with',
	'that',
	'this',
	'from',
	'into',
	'when',
	'what',
	'where',
	'which',
	'users',
	'user',
	'want',
	'need',
	'needs',
	'build',
	'create',
	'make',
	'allow',
	'lets',
	'let',
]);

function slugModuleId(brief: string): string {
	const word = brief
		.toLowerCase()
		.replace(/[^a-z0-9 ]/g, ' ')
		.split(/\s+/)
		.find((candidate) => candidate.length > 3 && !FILLER.has(candidate));
	return `${word ?? 'draft'}.core`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* A module is named by its whole dotted id (auth.core, never "auth" alone) or
   by an explicit "module <directory>" phrase. Bare directory words such as
   "users" are ordinary English and never select a module. */
export function mentionsModule(
	brief: string,
	module: WorkspaceModule,
): boolean {
	const text = brief.toLowerCase();
	const id = new RegExp(
		`(^|[^a-z0-9.-])${escapeRegExp(module.id)}(?![a-z0-9-])(?!\\.[a-z0-9])`,
	);
	const phrase = new RegExp(
		`\\bmodule\\s+${escapeRegExp(module.directory)}(?![a-z0-9-])`,
	);
	return id.test(text) || phrase.test(text);
}

function moduleFor(
	id: string,
	modules: readonly WorkspaceModule[],
): SessionModule {
	const known = modules.find((module) => module.id === id);
	return known
		? { id, directory: known.directory, kind: 'edit' }
		: { id, directory: moduleSuffixOf(id), kind: 'new' };
}

function planFor(
	modules: readonly SessionModule[],
	brief: string,
	firstRole: string,
	rationale: string,
	classifiedBy: WorkPlan['classifiedBy'],
	title = slugTitle(brief),
): WorkPlan {
	const primary = modules[0]!;
	return {
		kind: primary.kind === 'edit' ? 'edit-module' : 'new-module',
		moduleId: primary.id,
		title,
		sourceModule: primary.kind === 'edit' ? primary.directory : null,
		modules,
		firstRole,
		rationale,
		classifiedBy,
	};
}

/* Rules first: an existing module named in the request is a change to that
   module. Only what the rules cannot decide is left to the planner agent. */
export function classifyByRules(
	brief: string,
	modules: readonly WorkspaceModule[],
): WorkPlan {
	const named = modules.filter((module) => mentionsModule(brief, module));
	if (named.length > 0) {
		return planFor(
			named.map((module) => ({
				id: module.id,
				directory: module.directory,
				kind: 'edit' as const,
			})),
			brief,
			'backend-engineer',
			`The request names ${named.map((module) => module.id).join(' and ')}, ${named.length === 1 ? 'an existing module' : 'existing modules'}.`,
			'rules',
		);
	}
	return planFor(
		[moduleFor(slugModuleId(brief), modules)],
		brief,
		'business-manager',
		'No existing module matches the request.',
		'rules',
	);
}

/* The planner's answer is trusted for what it may know better than the rules
   (the title, the first role, a new module's id) and never for what the
   workspace already knows: an id that exists is a change to that module. */
export function parsePlan(
	output: string,
	modules: readonly WorkspaceModule[],
	roles: readonly AgentRoleDefinition[],
	fallback: WorkPlan,
): WorkPlan {
	const start = output.indexOf('{');
	const end = output.lastIndexOf('}');
	if (start < 0 || end <= start) return fallback;
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
	} catch {
		return fallback;
	}
	const listed = Array.isArray(value.modules)
		? (value.modules as unknown[]).filter(
				(entry): entry is string =>
					typeof entry === 'string' && MODULE_ID.test(entry),
			)
		: [];
	const primary =
		typeof value.moduleId === 'string' && MODULE_ID.test(value.moduleId)
			? value.moduleId
			: (listed[0] ?? fallback.moduleId);
	const ids = [primary, ...listed.filter((id) => id !== primary)];
	const role = roles.find((candidate) => candidate.id === value.firstRole);
	return planFor(
		ids.map((id) => moduleFor(id, modules)),
		'',
		role?.id ?? fallback.firstRole,
		typeof value.rationale === 'string'
			? value.rationale.trim().slice(0, 240)
			: fallback.rationale,
		'agent',
		typeof value.title === 'string' && value.title.trim().length > 1
			? value.title.trim().slice(0, 120)
			: fallback.title,
	);
}

export interface PlanRequest {
	readonly brief: string;
	readonly driver: string;
	readonly registry: CodingAgentRegistry;
	readonly roles: readonly AgentRoleDefinition[];
	readonly modules: readonly WorkspaceModule[];
	readonly signal?: AbortSignal;
}

/* The planner is a bounded classification turn: it reads nothing, writes
   nothing, and answers with one JSON object naming the target modules and the
   specialist who starts. Its failure is never fatal, because the rules already
   produced a usable plan. */
export async function planWork(request: PlanRequest): Promise<WorkPlan> {
	const fallback = classifyByRules(request.brief, request.modules);
	let driver;
	try {
		driver = await request.registry.resolve(request.driver);
	} catch {
		return fallback;
	}

	const catalogue = request.modules
		.map((module) => `${module.id} (modules/${module.directory})`)
		.join(', ');
	const roleList = request.roles
		.map((role) => `${role.id}: ${role.purpose}`)
		.join('\n');
	const instruction = `You are the sandbox planner. You classify one request and answer with a single JSON object. You never create, read, or change files, and you never run commands.

Answer with exactly this shape and nothing else:
{"kind":"new-module"|"edit-module","moduleId":"lowercase.dotted.id","modules":["lowercase.dotted.id"],"title":"three to six words","firstRole":"one role id","rationale":"one sentence"}

Rules:
- modules lists every module the request touches, the primary one first; moduleId repeats the primary one.
- An id from the existing modules list means a change to that module. Any other id means a new module: invent it as domain.core, naming the capability, not the technology.
- kind describes the primary module.
- firstRole is the specialist who should take the first turn.

Existing modules: ${catalogue || 'none'}

Roles:
${roleList}`;

	const workspacePath = await mkdtemp(join(tmpdir(), 'coreloom-plan-'));
	let output = '';
	try {
		for await (const event of driver.run({
			workspacePath,
			role: 'planner',
			systemInstruction: instruction,
			prompt: `Request:\n${request.brief}`,
			timeoutMs: PLAN_TIMEOUT_MS,
			signal: request.signal,
		})) {
			if (event.type === 'assistant.message') output += `\n${event.text}`;
		}
	} catch {
		return fallback;
	} finally {
		await rm(workspacePath, { recursive: true, force: true }).catch(
			() => undefined,
		);
	}
	return parsePlan(output, request.modules, request.roles, fallback);
}

export interface RoutingContext {
	readonly session: SandboxSession;
	readonly paths: SessionPaths;
	readonly roles: readonly AgentRoleDefinition[];
	readonly message: string;
	readonly hasSpec: boolean;
	readonly hasManifest: boolean;
	readonly hasServer: boolean;
	readonly hasClient: boolean;
	/* The handoff that ended the previous turn, when there was one. */
	readonly lastHandoff?: HandoffPlan | null;
}

const UI_WORDS =
	/\b(screen|view|layout|design|ux|widget|dashboard|form|button|copy|wording|empty state)\b/i;
const AGENT_WORDS = /\b(agent|tool|skill|automation|workflow|prompt)\b/i;
const SPEC_WORDS =
	/\b(spec|specification|scenario|requirement|acceptance|invariant)\b/i;

/* Routing is deterministic and explainable: the state of the module decides
   who works next, and the words of the request can only move the choice
   between specialists that are already valid for that state. */
export function routeRole(context: RoutingContext): {
	readonly role: string;
	readonly reason: string;
} {
	const has = (id: string) =>
		context.roles.some((role) => role.id === id) ? id : context.session.role;

	/* An operator message that follows a question is the answer to it, so it
	   goes back to the specialist who asked instead of to the default owner. */
	if (
		context.lastHandoff?.kind === 'question' &&
		context.roles.some((role) => role.id === context.lastHandoff!.role)
	) {
		return {
			role: context.lastHandoff.role,
			reason: `${context.lastHandoff.roleName} asked the question this message answers.`,
		};
	}
	if (SPEC_WORDS.test(context.message) || !context.hasSpec) {
		return {
			role: has('business-manager'),
			reason: !context.hasSpec
				? 'The module has no approved specification yet.'
				: 'The request is about the specification.',
		};
	}
	if (AGENT_WORDS.test(context.message)) {
		return {
			role: has('agentic-engineer'),
			reason: 'The request is about the agent surface of the module.',
		};
	}
	if (UI_WORDS.test(context.message)) {
		return {
			role: has(context.hasClient ? 'frontend-engineer' : 'ux-designer'),
			reason: context.hasClient
				? 'The request changes an existing screen.'
				: 'The module has no screen yet.',
		};
	}
	if (!context.hasManifest || !context.hasServer) {
		return {
			role: has('backend-engineer'),
			reason: 'The module still needs its server surface.',
		};
	}
	if (!context.hasClient) {
		return {
			role: has('frontend-engineer'),
			reason: 'The server exists and the module has no client yet.',
		};
	}
	return {
		role: has('backend-engineer'),
		reason: 'Default owner for a change with no clearer signal.',
	};
}

export interface HandoffContext {
	readonly routing: RoutingContext;
	/* The role that just finished its turn. */
	readonly role: string;
	readonly declared: HandoffDeclaration | null;
	readonly gates: readonly GateResult[];
	readonly failed: boolean;
	readonly changed: boolean;
	/* null when the module has no specification file at all. */
	readonly specApproved: boolean | null;
	readonly brief: string;
}

function roleName(roles: readonly AgentRoleDefinition[], id: string): string {
	return roles.find((role) => role.id === id)?.name ?? id;
}

function continuePrompt(name: string, reason: string, brief: string): string {
	return [
		`Continue this work as ${name}.`,
		reason ? `The previous specialist reported: ${reason}` : '',
		brief ? `The original request was: ${brief}` : '',
		'Do your part of it now, then end with your handoff line.',
	]
		.filter(Boolean)
		.join('\n\n');
}

function gateLabel(gate: GateResult): string {
	return gate.module ? `${gate.id} (modules/${gate.module})` : gate.id;
}

/* The declared handoff is honoured only when it names a role the finishing
   role may hand to. Anything else (an unknown role, a role outside the list,
   the role itself) falls back to the state routing with a note that says so. */
function validateDeclared(context: HandoffContext): {
	readonly role: string | null;
	readonly note: string;
} {
	const declared = context.declared?.role;
	if (!declared) return { role: null, note: '' };
	const roles = context.routing.roles;
	const current = roles.find((role) => role.id === context.role);
	if (declared === context.role) {
		return {
			role: null,
			note: `${roleName(roles, context.role)} named itself in the handoff line, so the state routing decided.`,
		};
	}
	if (!roles.some((role) => role.id === declared)) {
		return {
			role: null,
			note: `The handoff line named ${declared}, which is not a registered role, so the state routing decided.`,
		};
	}
	if (current && !current.handoff.includes(declared)) {
		return {
			role: null,
			note: `${current.name} may not hand off to ${roleName(roles, declared)}, so the state routing decided.`,
		};
	}
	return { role: declared, note: '' };
}

/* Who works next, decided in one place. The specialist's own handoff line is
   trusted when it names a role it may hand to, the deterministic routing
   answers when it does not, and an unapproved specification always stops for
   the operator. */
export function planHandoff(context: HandoffContext): HandoffPlan {
	const roles = context.routing.roles;
	const plan = (
		kind: HandoffPlan['kind'],
		role: string,
		reason: string,
		prompt = '',
	): HandoffPlan => ({
		kind,
		role,
		roleName: roleName(roles, role),
		reason,
		prompt,
	});

	if (context.failed) {
		return plan(
			'blocked',
			context.role,
			'The coding agent stopped with an error, so nothing continues on its own.',
		);
	}

	const failedGate = context.gates.find((gate) => gate.status === 'failed');
	if (failedGate) {
		return plan(
			'continue',
			context.role,
			`The ${gateLabel(failedGate)} gate failed, so the same specialist fixes it before anyone else works.`,
			[
				`The ${gateLabel(failedGate)} gate failed after your change. Fix exactly what it reports, change nothing else, and end with your handoff line.`,
				`Gate command: ${failedGate.command}`,
				`Gate output (first ${GATE_PROMPT_OUTPUT} characters; the transcript holds the rest):`,
				failedGate.output.slice(0, GATE_PROMPT_OUTPUT),
			].join('\n\n'),
		);
	}

	const validated = validateDeclared(context);
	const declared = validated.role;
	const routed = routeRole(context.routing).role;
	const next = declared ?? (routed === context.role ? null : routed);
	const withNote = (reason: string) =>
		validated.note ? `${reason} ${validated.note}` : reason;
	const finished = context.declared !== null && context.declared.role === null;

	/* A turn that finished without touching a file did not finish the work: it
	   needs an answer, not a review, whatever the specification's status. */
	if (finished && !context.changed) {
		return plan(
			'question',
			context.role,
			context.declared!.reason ||
				'The specialist needs an answer before it can continue.',
		);
	}

	if (context.specApproved === false) {
		const implementer = next ?? 'backend-engineer';
		return plan(
			'approval',
			implementer,
			withNote(
				'The specification is written and needs your approval before anyone implements it.',
			),
			continuePrompt(
				roleName(roles, implementer),
				context.declared?.reason ?? '',
				context.brief,
			),
		);
	}

	/* In a change session the specification is a means, not the deliverable: a
	   business manager that updated it hands the change on to the implementer
	   instead of reporting the request done. */
	if (
		finished &&
		context.routing.session.kind === 'edit-module' &&
		context.role === 'business-manager'
	) {
		const implementer =
			routed !== context.role && roles.some((role) => role.id === routed)
				? routed
				: 'backend-engineer';
		return plan(
			'continue',
			implementer,
			`The specification is updated; ${roleName(roles, implementer)} implements the change.`,
			continuePrompt(
				roleName(roles, implementer),
				context.declared?.reason ?? '',
				context.brief,
			),
		);
	}

	if (finished) {
		return plan(
			'review',
			context.role,
			context.declared!.reason ||
				'The specialist reports the request is fully satisfied.',
		);
	}

	if (!next) {
		return plan(
			context.changed ? 'review' : 'question',
			context.role,
			withNote(
				context.changed
					? 'Nothing else is routed automatically. Review the change and eject it when you are happy.'
					: 'The turn changed nothing. Answer what the specialist asked, or say what should happen next.',
			),
		);
	}

	return plan(
		'continue',
		next,
		withNote(
			(declared && context.declared?.reason) ||
				`${roleName(roles, next)} owns what remains after this turn.`,
		),
		continuePrompt(
			roleName(roles, next),
			declared ? (context.declared?.reason ?? '') : '',
			context.brief,
		),
	);
}

export function assertBrief(value: string): string {
	const brief = value.trim();
	if (brief.length < 8 || brief.length > 20_000) {
		throw new SandboxSetupError(
			'INVALID_BRIEF',
			'Describe the work in at least 8 characters.',
		);
	}
	return brief;
}
