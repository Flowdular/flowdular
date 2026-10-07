import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
	AgentRoleDefinition,
	CodingAgentRegistry,
	CodingAgentEvent,
	HandoffDeclaration,
} from '@flowdular/coding-agent';
import {
	DECISION_LIMITS,
	type ChoiceAnswer,
	type DecisionResult,
} from '@flowdular/ai-provider';
import type { DecisionAsk } from './decisions-runtime.ts';
import {
	summarizeGate,
	type GateIssue,
	type GateResult,
	type GateSummary,
} from './gates.ts';
import {
	mayWrite,
	ownerOf,
	planGateRepair,
	type GateFailure,
} from './gate-repair.ts';
import {
	QUESTIONS_LIMITS,
	SPEC_OWNER_ROLE,
	type QuestionsReading,
} from './questions.ts';
import { SandboxSetupError } from './workspace-root.ts';
import {
	moduleSuffixOf,
	type ChatEntry,
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
	readonly classifiedBy: 'agent' | 'rules' | 'decision';
}

/* Who owns spec/module.yaml, for a new module and for a change alike. */
export { SPEC_OWNER_ROLE };
/* Who implements when nothing better is routed. */
const DEFAULT_IMPLEMENTER_ROLE = 'backend-engineer';

const PLAN_TIMEOUT_MS = 3 * 60 * 1000;
const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
/* Bounded output for the fix prompt; the transcript keeps the whole output. */
const GATE_PROMPT_OUTPUT = 4_000;
/* A turn message is at most 20000 characters (turns.ts), and a repair that
   could not be sent would end the chain on an error instead. */
const REPAIR_PROMPT_LIMIT = 19_000;
const DEFERRED_LINES = 20;

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

/* Where the brief first names this module, or -1. A module is named by its
   whole dotted id (auth.core, never "auth" alone) or by an explicit
   "module <directory>" phrase. Bare directory words such as "users" are
   ordinary English and never select a module. */
export function mentionIndex(brief: string, module: WorkspaceModule): number {
	const text = brief.toLowerCase();
	const id = new RegExp(
		`(^|[^a-z0-9.-])${escapeRegExp(module.id)}(?![a-z0-9-])(?!\\.[a-z0-9])`,
	).exec(text);
	const phrase = new RegExp(
		`\\bmodule\\s+${escapeRegExp(module.directory)}(?![a-z0-9-])`,
	).exec(text);
	const found = [id?.index ?? -1, phrase?.index ?? -1].filter(
		(index) => index >= 0,
	);
	return found.length > 0 ? Math.min(...found) : -1;
}

export function mentionsModule(
	brief: string,
	module: WorkspaceModule,
): boolean {
	return mentionIndex(brief, module) >= 0;
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

/* A module id the workspace does not have yet. Only the `<domain>.core`
   convention the planner and the scaffold use counts, so a file name such as
   package.json is never read as a request for a module. */
const INVENTED_ID =
	/(^|[^a-z0-9.-])([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.core)(?![a-z0-9-])/g;

/* Every module the brief names, in the order it names them: a known id is a
   change to that module, an invented `<domain>.core` id is a new one. */
function namedModules(
	brief: string,
	modules: readonly WorkspaceModule[],
): readonly SessionModule[] {
	const found: { readonly at: number; readonly module: SessionModule }[] = [];
	for (const module of modules) {
		const at = mentionIndex(brief, module);
		if (at < 0) continue;
		found.push({
			at,
			module: { id: module.id, directory: module.directory, kind: 'edit' },
		});
	}
	const known = new Set(modules.map((module) => module.id));
	const seen = new Set<string>();
	for (const match of brief.toLowerCase().matchAll(INVENTED_ID)) {
		const id = match[2]!;
		if (known.has(id) || seen.has(id)) continue;
		seen.add(id);
		found.push({ at: match.index, module: moduleFor(id, modules) });
	}
	return found
		.sort((left, right) => left.at - right.at)
		.map((entry) => entry.module);
}

function rationaleFor(modules: readonly SessionModule[]): string {
	const existing = modules.filter((module) => module.kind === 'edit');
	const created = modules.filter((module) => module.kind === 'new');
	const parts = [
		...(existing.length > 0
			? [
					`${existing.map((module) => module.id).join(' and ')}, ${
						existing.length === 1 ? 'an existing module' : 'existing modules'
					}`,
				]
			: []),
		...(created.length > 0
			? [
					`${created.map((module) => module.id).join(' and ')}, which ${
						created.length === 1 ? 'does' : 'do'
					} not exist yet`,
				]
			: []),
	];
	return `The request names ${parts.join(', and ')}.`;
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

/* Rules first: every existing module named in the request is a change to that
   module, and an invented id is a new one. Only what the rules cannot decide is
   left to the planner agent. The specification owner always takes the first
   turn, because a change is described before it is implemented. */
export function classifyByRules(
	brief: string,
	modules: readonly WorkspaceModule[],
): WorkPlan {
	const named = namedModules(brief, modules);
	if (named.length > 0) {
		return planFor(named, brief, SPEC_OWNER_ROLE, rationaleFor(named), 'rules');
	}
	return planFor(
		[moduleFor(slugModuleId(brief), modules)],
		brief,
		SPEC_OWNER_ROLE,
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
	const ids = new Set([primary, ...listed]);
	const named = [...ids].map((id) => moduleFor(id, modules));
	/* A module this workspace already has and the brief named belongs to the
	   work whatever the planner listed. */
	for (const module of fallback.modules) {
		if (module.kind !== 'edit') continue;
		if (named.some((entry) => entry.id === module.id)) continue;
		named.push(module);
	}
	const role = roles.find((candidate) => candidate.id === value.firstRole);
	return planFor(
		named,
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
	readonly onEvent?: (event: CodingAgentEvent) => void;
	/* A typed-decision provider, when the operator configured one. It answers
	   the classification without a coding-agent turn; below its thresholds the
	   planner turn still runs. */
	readonly decide?: DecisionAsk;
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
/* Acting on a choice changes which module a session opens on, which the
   operator sees and can correct in the first message, so the bar is the
   vendor's middle tier rather than its high one. A brief that spans modules is
   handed back to the planner turn, which can name several. */
const DECISION_MODULE_CONFIDENCE = 0.7;
const DECISION_ROLE_CONFIDENCE = 0.6;
const DECISION_MULTI_MODULE = 0.5;
const NO_EXISTING_MODULE = 'none_of_these';

function choiceAnswer(
	result: DecisionResult,
	name: string,
): ChoiceAnswer | null {
	const answer = result.answers[name];
	return answer?.type === 'choice' ? answer : null;
}

/**
 * The classification as typed questions: which existing module the request
 * changes, whether it spans more than one, and who should take the first turn.
 * Returns null whenever the answers do not clear their thresholds, so the
 * caller falls back to the planner turn it would have run anyway.
 */
async function planByDecisions(
	request: PlanRequest,
	fallback: WorkPlan,
): Promise<WorkPlan | null> {
	const decide = request.decide;
	if (!decide) return null;
	/* One option per module plus the escape hatch. A workspace with more
	   modules than that would be asked about a subset, and a confident answer
	   about the wrong subset is worse than no answer, so it asks nothing. */
	const candidates = request.modules;
	if (
		candidates.length === 0 ||
		candidates.length > DECISION_LIMITS.options - 1
	)
		return null;
	const state = [
		`Request: ${request.brief}`,
		'',
		'Existing modules:',
		...candidates.map(
			(module) => `- ${module.id} (modules/${module.directory})`,
		),
		'',
		'Specialists:',
		...request.roles.map((role) => `- ${role.id}: ${role.purpose}`),
	].join('\n');
	let result: DecisionResult;
	try {
		result = await decide({
			state,
			questions: {
				module: {
					type: 'choice',
					instruction: `Which existing module does this request change? Answer ${NO_EXISTING_MODULE} when the request describes something none of them covers.`,
					options: [
						...candidates.map((module) => module.id),
						NO_EXISTING_MODULE,
					],
				},
				spans_modules: {
					type: 'noul',
					instruction:
						'Does this request change more than one of the existing modules?',
				},
				role: {
					type: 'choice',
					instruction:
						'Which specialist should take the first turn on this request?',
					options: request.roles.map((role) => role.id),
				},
			},
		});
	} catch {
		/* A decision provider that is down or rate limited is never fatal. */
		return null;
	}
	const spans = result.answers.spans_modules;
	if (spans?.type === 'noul' && spans.noul >= DECISION_MULTI_MODULE)
		return null;
	const module = choiceAnswer(result, 'module');
	if (!module || module.confidence < DECISION_MODULE_CONFIDENCE) return null;
	const role = choiceAnswer(result, 'role');
	const firstRole =
		role &&
		role.confidence >= DECISION_ROLE_CONFIDENCE &&
		request.roles.some((known) => known.id === role.choice)
			? role.choice
			: fallback.firstRole;
	if (module.choice === NO_EXISTING_MODULE) {
		/* The modules are the ones the rules chose, so the transcript keeps
		   crediting the rules; only the first role comes from the decision. */
		return { ...fallback, firstRole };
	}
	const named = candidates.find((known) => known.id === module.choice);
	if (!named) return null;
	const chosen: SessionModule = {
		id: named.id,
		directory: named.directory,
		kind: 'edit',
	};
	return planFor(
		[chosen],
		request.brief,
		firstRole,
		`${rationaleFor([chosen])} Confidence ${module.confidence.toFixed(2)}.`,
		'decision',
	);
}

export async function planWork(request: PlanRequest): Promise<WorkPlan> {
	const fallback = classifyByRules(request.brief, request.modules);
	const decided = await planByDecisions(request, fallback);
	if (decided) return decided;
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
- A request that spans several modules names all of them, for example {"moduleId":"parties.core","modules":["parties.core","catalog.core"]} for a field added in one module and shown on another module's screen.
- An id from the existing modules list means a change to that module. Any other id means a new module: invent it as domain.core, naming the capability, not the technology.
- kind describes the primary module.
- firstRole is the specialist who should take the first turn.

Existing modules: ${catalogue || 'none'}

Roles:
${roleList}`;

	const workspacePath = await mkdtemp(join(tmpdir(), 'flowdular-plan-'));
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
			request.onEvent?.(event);
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
	/* The gate on the module this turn works in: false while the operator has
	   not approved its specification, null when it has none at all. */
	readonly specApproved: boolean | null;
	/* The handoff that ended the previous turn, when there was one. */
	readonly lastHandoff?: HandoffPlan | null;
}

/* Who takes the turn that answers a question. Any role but the specification
   owner implements an approved specification, so a question it had to ask is
   about something that specification does not decide: the owner applies the
   answer to it first. A session without that role leaves the answer with the
   role that asked. */
export function answeringRole(
	asker: string,
	roles: readonly AgentRoleDefinition[],
): string {
	return asker !== SPEC_OWNER_ROLE &&
		roles.some((role) => role.id === SPEC_OWNER_ROLE)
		? SPEC_OWNER_ROLE
		: asker;
}

/* An implementer's questions, answered by the operator, while the
   specification owner applies the answers. */
export interface SpecFollowUp {
	readonly role: string;
	readonly roleName: string;
	readonly module?: string;
	/* The request text that answered the questions, read back to the role that
	   asked when it resumes. */
	readonly decisions: string;
}

/* The implementer a specification owner's turn is answering for, read from the
   transcript the turn starts on. The newest handoff that is not the owner's own
   (its questions, repairs and requested changes do not end the wait) is the
   implementer's question; the first operator message after it is the answer.
   When the transcript holds no message after the question yet, the turn's own
   request text is the answer. */
export function specFollowUp(
	entries: readonly ChatEntry[],
	roles: readonly AgentRoleDefinition[],
	message: string,
): SpecFollowUp | null {
	let answer: string | null = null;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index]!;
		if (entry.kind === 'user' && entry.text) answer = entry.text;
		const handoff = entry.handoff;
		if (!handoff || handoff.role === SPEC_OWNER_ROLE) continue;
		if (
			handoff.kind !== 'question' ||
			!roles.some((role) => role.id === handoff.role)
		) {
			return null;
		}
		return {
			role: handoff.role,
			roleName: handoff.roleName,
			...(handoff.module ? { module: handoff.module } : {}),
			decisions: answer ?? message,
		};
	}
	return null;
}

export function specFollowUpReason(asker: string, owner: string): string {
	return `${asker} asked about something the approved specification does not decide, so ${owner} applies your answers to it first.`;
}

/* What the specification owner reads beside the answers. The specification
   text afterwards is the decision: a changed text needs the operator's approval
   of the new hash before the implementer resumes, an unchanged one does not. */
export function specFollowUpNote(asker: string): string {
	return `These decisions answer questions ${asker} asked while implementing the approved specification. Record each decision that adds or changes what the module must do (an error code, field, permission, state, transition or behaviour the approved text does not state) in spec/module.yaml: set status to draft, add the invariants, acceptance scenarios and decisions it needs, and change nothing else. The operator approves the new text before ${asker} continues. Leave the file untouched when the approved text already states every decision; ${asker} then continues without a new approval.`;
}

function resumePrompt(
	name: string,
	decisions: string,
	specificationChanged: boolean,
	brief: string,
): string {
	return [
		`Continue this work as ${name}. The operator answered the questions you asked.`,
		decisions,
		specificationChanged
			? 'The specification now records these decisions and the operator approved the new text. Implement them as the specification states.'
			: 'The approved specification already states these decisions, so it did not change. Implement within it.',
		brief ? `The original request was: ${brief}` : '',
		'Do your part of it now, then end with your handoff line.',
	]
		.filter(Boolean)
		.join('\n\n');
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
	   goes to whoever answers for the specialist that asked instead of to the
	   default owner. */
	if (
		context.lastHandoff?.kind === 'question' &&
		context.roles.some((role) => role.id === context.lastHandoff!.role)
	) {
		const asker = context.lastHandoff;
		const role = answeringRole(asker.role, context.roles);
		return {
			role,
			reason:
				role === asker.role
					? `${asker.roleName} asked the question this message answers.`
					: specFollowUpReason(asker.roleName, roleName(context.roles, role)),
		};
	}
	if (
		SPEC_WORDS.test(context.message) ||
		!context.hasSpec ||
		context.specApproved === false
	) {
		return {
			role: has(SPEC_OWNER_ROLE),
			reason: !context.hasSpec
				? 'The module has no approved specification yet.'
				: context.specApproved === false
					? 'The specification of this module is not approved yet, so nobody implements before it is.'
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
	readonly reviewing?: boolean;
	readonly routing: RoutingContext;
	/* The role that just finished its turn. */
	readonly role: string;
	/* The draft module directory that turn worked in. */
	readonly module: string;
	readonly declared: HandoffDeclaration | null;
	readonly gates: readonly GateResult[];
	readonly failed: boolean;
	readonly changed: boolean;
	/* Whether the agent wrote any file in this turn; `changed` is whether the
	   session differs from its base at all. Absent reads as written. */
	readonly edited?: boolean;
	/* Whether the turn ran the previous handoff's own prompt rather than an
	   operator message. Absent reads as an operator message. */
	readonly instructed?: boolean;
	/* null when the module has no specification file at all. */
	readonly specApproved: boolean | null;
	readonly brief: string;
	/* What the closing reply asked the operator, as the questions protocol
	   read it. Absent reads as asking nothing. */
	readonly questions?: QuestionsReading;
	/* The last handoff before this turn ran, so a repeated repair is seen. */
	readonly previous?: HandoffPlan | null;
	/* Set on a specification owner's turn that applies an implementer's
	   answered questions. */
	readonly resume?: SpecFollowUp | null;
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

/* A module file a handoff line names: a path under a module directory, or a
   manifest. One qualified with a module outside the session is a reference
   no turn here could write. */
const NAMED_PATH =
	/(?:^|[\s(`'"])(?:\.\/)?(?:modules\/([a-z0-9-]+)\/)?((?:spec|src|tests|translations|migrations|preview|adapters|templates)\/[^\s,;:()`'"]*|module\.json|package\.json)/g;

interface NamedPath {
	readonly path: string;
	readonly module: string;
}

function namedPaths(
	text: string,
	modules: readonly string[],
	active: string,
): NamedPath[] {
	const named = new Map<string, NamedPath>();
	for (const match of text.matchAll(NAMED_PATH)) {
		const module = match[1] ?? active;
		if (!modules.includes(module)) continue;
		const file = match[2]!.replace(/\.+$/, '');
		const path = /(\/|\.[^/]+)$/.test(file) ? file : `${file}/`;
		named.set(`${module}/${path}`, { path, module });
	}
	return [...named.values()];
}

/* Work a handoff line names outside the finishing role's write paths goes to
   a role that may write it, in the module it names, by the rule a gate repair
   follows. A role that may write none of it is never chosen, and nobody is
   when no role may. */
function scopedHandoff(
	context: HandoffContext,
	proposed: string | null,
): {
	readonly role: string | null;
	readonly module: string;
	readonly rerouted: boolean;
	readonly note: string;
	/* Why the chain stops, when no role may write the named work. */
	readonly stop: string | null;
} {
	const roles = context.routing.roles;
	const current = roles.find((role) => role.id === context.role);
	const outside = context.declared?.role
		? namedPaths(
				context.declared.reason,
				context.routing.session.modules.map((module) => module.directory),
				context.module,
			).filter((named) => !current || !mayWrite(current, named.path))
		: [];
	const candidate = roles.find((role) => role.id === proposed);
	const unchanged = {
		role: proposed,
		module: context.module,
		rerouted: false,
		note: '',
		stop: null,
	};
	if (
		outside.length === 0 ||
		(candidate && outside.some((named) => mayWrite(candidate, named.path)))
	)
		return unchanged;
	const listed = outside
		.map((named) =>
			named.module === context.module
				? named.path
				: `modules/${named.module}/${named.path}`,
		)
		.join(', ');
	for (const named of outside) {
		const owner =
			ownerOf(named.path, roles) ??
			roles.find((role) => mayWrite(role, named.path))?.id ??
			null;
		if (!owner) continue;
		return {
			...unchanged,
			role: owner,
			module: named.module,
			rerouted: true,
			note: `${candidate?.name ?? roleName(roles, context.role)} may not write ${listed}, so ${roleName(roles, owner)} takes it.`,
		};
	}
	return {
		...unchanged,
		role: null,
		note: `No specialist in this session may write ${listed}.`,
		stop: `${roleName(roles, context.role)} handed on work in ${listed}, which no specialist in this session may write, so the chain stops here. Make that change by hand, or say what should change.`,
	};
}

function gatesFailed(gates: readonly GateResult[]): string {
	const labels = gates.map(gateLabel);
	return labels.length === 1
		? `${labels[0]} gate failed`
		: `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)} gates failed`;
}

function failedGatesOf(failures: readonly GateFailure[]): GateResult[] {
	return [...new Set(failures.map((failure) => failure.gate))];
}

function issuesOf(
	gate: GateResult,
	failures: readonly GateFailure[],
): GateIssue[] {
	return failures.flatMap((failure) =>
		failure.gate === gate && failure.issue ? [failure.issue] : [],
	);
}

/* What the repair turn reads for one gate: the errors in its files when the
   gate reported errors, the bounded output when it printed only text. The
   validator envelope itself stays in the transcript. */
function repairSection(gate: GateResult, failures: readonly GateFailure[]) {
	if (gate.issues) {
		const assigned = issuesOf(gate, failures);
		const reported = gate.issues.length + (gate.moreIssues ?? 0);
		const count =
			assigned.length < reported ? ` (${assigned.length} of ${reported})` : '';
		const lines = assigned.map(
			(issue) =>
				`- ${[issue.code, issue.file, issue.path].filter(Boolean).join(' ')}: ${issue.message}`,
		);
		return `Errors the ${gateLabel(gate)} gate reported${count}:\n${lines.join('\n')}`;
	}
	return [
		`Gate command (${gateLabel(gate)}): ${gate.command}`,
		`Gate output (first ${GATE_PROMPT_OUTPUT} characters; the transcript holds the rest):\n${gate.output.slice(0, GATE_PROMPT_OUTPUT)}`,
	].join('\n\n');
}

/* A gate as the repair turn received it: the errors it was sent, and how
   many more the gate reported, to this turn's files or another's. */
function sentGate(
	gate: GateResult,
	failures: readonly GateFailure[],
): GateSummary {
	const { issues, moreIssues, ...summary } = summarizeGate(gate);
	if (!issues) return summary;
	const assigned = issuesOf(gate, failures);
	const more = issues.length + (moreIssues ?? 0) - assigned.length;
	return {
		...summary,
		issues: assigned,
		...(more > 0 ? { moreIssues: more } : {}),
	};
}

function deferredSection(
	failures: readonly GateFailure[],
	roles: readonly AgentRoleDefinition[],
): string[] {
	const lines = [
		...new Set(
			failures.map(
				(failure) =>
					`- ${gateLabel(failure.gate)}: ${
						[failure.issue?.code, failure.path].filter(Boolean).join(' ') ||
						'no file named'
					}${failure.owner ? ` (${roleName(roles, failure.owner)})` : ''}`,
			),
		),
	];
	if (lines.length === 0) return [];
	const more =
		lines.length > DEFERRED_LINES
			? [`- and ${lines.length - DEFERRED_LINES} more in the transcript`]
			: [];
	return [
		`Another turn fixes these after yours, so leave them:\n${[
			...lines.slice(0, DEFERRED_LINES),
			...more,
		].join('\n')}`,
	];
}

function bounded(prompt: string): string {
	return prompt.length <= REPAIR_PROMPT_LIMIT
		? prompt
		: `${prompt.slice(0, REPAIR_PROMPT_LIMIT - 60)}\n[cut: the transcript holds the rest]`;
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
		module = context.module,
		options: {
			readonly repair?: boolean;
			readonly resendQuestions?: boolean;
			readonly gates?: readonly GateSummary[];
			readonly author?: string;
		} = {},
	): HandoffPlan => ({
		kind,
		role,
		roleName: roleName(roles, role),
		reason,
		prompt,
		module,
		...(options.repair ? { repair: true } : {}),
		...(options.resendQuestions ? { resendQuestions: true } : {}),
		...(options.gates ? { gates: options.gates } : {}),
		...(options.author ? { author: options.author } : {}),
	});

	if (context.failed) {
		return plan(
			'blocked',
			context.role,
			'The coding agent stopped with an error, so nothing continues on its own.',
		);
	}

	/* Open questions stop the chain whatever else the turn did. An approval
	   or a next specialist would otherwise run past decisions nobody made. A
	   gate that did not pass waits too, and the reason says so: the gates run
	   again after the answering turn, and what still does not pass then gets
	   its repair turn. */
	if (context.questions?.kind === 'valid') {
		const unpassed = context.gates.find((gate) => gate.status !== 'passed');
		return plan(
			'question',
			context.role,
			unpassed
				? `The specialist needs your decisions before it can continue. The ${gateLabel(unpassed)} gate did not pass either: the gates run again after your answers, and one that still does not pass goes back to the specialist.`
				: 'The specialist needs your decisions before it can continue.',
		);
	}

	/* A block the protocol refused goes back to the specialist that wrote it,
	   once, with the reason and the limits. It is never dropped in silence. */
	if (context.questions?.kind === 'invalid') {
		const reason = context.questions.reason;
		const previous = context.previous;
		if (previous?.resendQuestions === true && previous.role === context.role) {
			return plan(
				'question',
				context.role,
				`The questions block was refused again: ${reason} Answer in your own words, or ask the specialist to ask again.`,
			);
		}
		return plan(
			'continue',
			context.role,
			`The questions block was refused: ${reason} ${roleName(roles, context.role)} sends it again within the limits.`,
			[
				`Your questions block was refused: ${reason}`,
				`Send the same questions again as one corrected questions block at the end of your reply. ${QUESTIONS_LIMITS} Shorten an option that is too long, or move its detail into the question. Change no files. End with your handoff line.`,
			].join('\n\n'),
			context.module,
			{ repair: true, resendQuestions: true },
		);
	}

	/* The specification owner applied an implementer's answers. The text it
	   left behind says which case that was: a changed specification goes back
	   to the operator for approval of the new hash, an unchanged one lets the
	   implementer continue at once. Either way the implementer that asked
	   resumes, whatever role the owner's handoff line named. */
	const resume =
		context.resume && context.specApproved !== null ? context.resume : null;
	const resumed = (
		waiting: SpecFollowUp,
		unpassed: readonly GateResult[],
	): HandoffPlan => {
		const changed = context.specApproved === false;
		return plan(
			changed ? 'approval' : 'continue',
			waiting.role,
			[
				unpassed.length > 0
					? `The ${gatesFailed(unpassed)}: the gates run again after ${waiting.roleName} continues, and what still does not pass then gets its repair turn.`
					: '',
				changed
					? 'The specification now records your decisions and is ready for your review.'
					: `Your decisions stay inside the approved specification, so ${waiting.roleName} continues without a new approval.`,
			]
				.filter(Boolean)
				.join(' '),
			resumePrompt(waiting.roleName, waiting.decisions, changed, context.brief),
			waiting.module ?? context.module,
		);
	};

	/* A failure is fixed by a role that may write the file its fix goes in,
	   in the module it belongs to, even when the finished turn worked
	   somewhere else. What another role owns waits for the turn after. */
	const failedGates = context.gates.filter((gate) => gate.status !== 'passed');
	if (failedGates.length > 0) {
		/* A repair turn that changed nothing is not sent the same errors
		   again: the next attempt goes to another role that may write them,
		   or to the operator when none may. */
		const repairing =
			context.instructed === true &&
			context.previous?.repair === true &&
			context.previous.resendQuestions !== true &&
			context.previous.role === context.role;
		const idle =
			repairing && !context.reviewing && context.edited === false
				? context.role
				: null;
		const idleNote = idle
			? `${roleName(roles, idle)} changed no files in its repair turn.`
			: '';
		const author = repairing
			? (context.previous!.author ?? context.role)
			: context.role;
		const repair = planGateRepair({
			gates: failedGates,
			activeModule: context.module,
			roles,
			modules: context.routing.session.modules.map(
				(module) => module.directory,
			),
			fallback: context.reviewing
				? (scopedHandoff(context, validateDeclared(context).role).role ??
					context.role)
				: author,
			exclude: idle,
		});
		/* Only the owner's next turn in this module still answers for the
		   implementer, so any other repair waits until the implementer has
		   resumed with the decisions. */
		if (
			resume &&
			!(repair?.role === SPEC_OWNER_ROLE && repair.module === context.module)
		)
			return resumed(resume, failedGates);
		if (!repair) {
			return plan(
				'blocked',
				context.role,
				`${idleNote} No other specialist is assigned what the ${gatesFailed(failedGates)} on, so the chain stops here. Fix it by hand, or say what should change.`,
			);
		}
		const sent = failedGatesOf(repair.assigned);
		return plan(
			'continue',
			repair.role,
			[
				idleNote,
				`The ${gatesFailed(sent)}, so the responsible specialist fixes ${sent.length === 1 ? 'it' : 'them'} before delivery.`,
			]
				.filter(Boolean)
				.join(' '),
			bounded(
				[
					`Continue as ${roleName(roles, repair.role)}. The ${gatesFailed(sent)}. Fix the reported files within your role, preserve other work, and end with your handoff line.`,
					`Recorded gate results:\n${context.gates.map((gate) => `${gateLabel(gate)}: ${gate.status}`).join('\n')}`,
					...sent.map((gate) => repairSection(gate, repair.assigned)),
					...deferredSection(repair.deferred, roles),
				].join('\n\n'),
			),
			repair.module,
			{
				repair: true,
				gates: sent.map((gate) => sentGate(gate, repair.assigned)),
				author,
			},
		);
	}

	if (resume) return resumed(resume, []);

	const validated = validateDeclared(context);
	const declared = validated.role;
	const routed = routeRole(context.routing).role;
	const scoped = scopedHandoff(
		context,
		declared ?? (routed === context.role ? null : routed),
	);
	const next = scoped.role;
	const note = scoped.note || validated.note;
	const withNote = (reason: string) => (note ? `${reason} ${note}` : reason);
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
		const implementer = next ?? DEFAULT_IMPLEMENTER_ROLE;
		return plan(
			'approval',
			implementer,
			withNote('The specification is ready for your review.'),
			continuePrompt(
				roleName(roles, implementer),
				context.declared?.reason ?? '',
				context.brief,
			),
		);
	}

	/* The specification is approved, so a business manager that wrote it hands
	   the change on to the implementer instead of reporting the request done. */
	if (
		finished &&
		context.routing.session.kind === 'edit-module' &&
		context.role === SPEC_OWNER_ROLE
	) {
		const implementer =
			routed !== context.role && roles.some((role) => role.id === routed)
				? routed
				: DEFAULT_IMPLEMENTER_ROLE;
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

	if (scoped.stop) return plan('blocked', context.role, scoped.stop);

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

	const reported =
		declared || scoped.rerouted ? (context.declared?.reason ?? '') : '';
	return plan(
		'continue',
		next,
		withNote(
			reported || `${roleName(roles, next)} owns what remains after this turn.`,
		),
		continuePrompt(roleName(roles, next), reported, context.brief),
		scoped.module,
	);
}

export interface SpecGateContext {
	readonly roles: readonly AgentRoleDefinition[];
	/* The draft module directory the refused turn was for. */
	readonly module: string;
	readonly refusedRole: string;
	/* True when the draft specification already carries a change to review. */
	readonly changed: boolean;
	readonly brief: string;
}

/* The move after a turn an implementer may not take. A specification change on
   the table is the operator's to review; without one the specification owner
   writes it first, which is what keeps a change spec-driven. */
export function planSpecGateHandoff(context: SpecGateContext): HandoffPlan {
	const named = (id: string) => roleName(context.roles, id);
	if (context.changed) {
		return {
			kind: 'approval',
			role: context.refusedRole,
			roleName: named(context.refusedRole),
			reason: 'The specification change is ready for your review.',
			prompt: continuePrompt(named(context.refusedRole), '', context.brief),
			module: context.module,
		};
	}
	if (!context.roles.some((role) => role.id === SPEC_OWNER_ROLE)) {
		return {
			kind: 'blocked',
			role: context.refusedRole,
			roleName: named(context.refusedRole),
			reason:
				'The specification is not approved and the business-manager role is not configured, so implementation remains blocked.',
			prompt: '',
			module: context.module,
		};
	}
	return {
		kind: 'continue',
		role: SPEC_OWNER_ROLE,
		roleName: named(SPEC_OWNER_ROLE),
		reason: `The specification does not describe this change yet, so ${named(
			SPEC_OWNER_ROLE,
		)} writes the delta before anyone implements it.`,
		prompt: [
			'Update this module specification so it describes the requested change, and change nothing else.',
			context.brief ? `The request was: ${context.brief}` : '',
			'Bump specVersion, add or change the acceptance scenarios the change needs, and state the permissions, invariants and data ownership it introduces. A small change deserves a small delta. Leave status as it is: the operator approves it.',
			'End with your handoff line.',
		]
			.filter(Boolean)
			.join('\n\n'),
		module: context.module,
	};
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
