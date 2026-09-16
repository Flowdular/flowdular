import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { AgentHarnessError } from './errors.ts';
import {
	APPROVAL_GRANT_MAX_TOKEN_LENGTH,
	approvalGrantKeyringFromEnvironment,
	approvalInputDigest,
	normalizeActor,
	verifyApprovalGrant,
	type Actor,
	type ApprovalGrantKeyring,
	type ApprovalGrantReason,
	type UserActor,
} from '@flowdular/kernel';
import {
	boundToolOutput,
	toolTimeoutMs,
	validateJsonValue,
	validateToolInput,
	validateToolOutput,
	validateStructuredOutput,
} from './tool-contract.ts';

export { AgentHarnessError } from './errors.ts';

export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
export const MIN_MAX_OUTPUT_TOKENS = 256;
export const MAX_MAX_OUTPUT_TOKENS = 65_536;

export type AgentRunTrigger =
	| 'playground'
	| 'workflow'
	| 'service'
	| 'schedule';

export interface AgentExecutionDefinition {
	readonly id: string;
	readonly name: string;
	readonly revision: number;
	readonly instructions: string;
	readonly provider: string;
	readonly model: string;
	readonly allowedTools: readonly string[];
	readonly maxSteps: number;
	readonly timeoutMs: number;
	readonly temperature: number;
	/* Absent means the provider default of 4096 tokens. */
	readonly maxOutputTokens?: number;
}

export interface AgentExecutionRequest {
	readonly runId: string;
	readonly tenantId: string;
	readonly requestedBy: string;
	readonly requestedActor: Actor;
	/* Audit provenance remains requestedActor. Live authorization uses this user. */
	readonly authorizationSubject?: UserActor | null;
	readonly trigger: AgentRunTrigger;
	readonly input: string;
	readonly definition: AgentExecutionDefinition;
	readonly permissionSnapshot: readonly string[];
	readonly toolGrants: readonly string[];
	/* Signed approval grants (`issueApprovalGrant`) for the external or
	   destructive tools this run may call, each bound to one tool id and one
	   input digest. Absent means no such tool is offered. */
	readonly grants?: readonly string[];
	/* Absent keeps the v1 text behavior. */
	readonly outputContract?: AgentOutputContract;
	/* An absolute path to a research-fixtures.json the local simulation answers
	   a granted native web search from. Set by the platform, never by input. */
	readonly nativeFixturesPath?: string;
}

export const MAX_APPROVAL_GRANTS = 16;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export type AgentOutputContract =
	| { readonly kind: 'text' }
	| {
			readonly kind: 'json-schema';
			readonly name: string;
			readonly schema: Readonly<Record<string, unknown>>;
	  };

export interface AgentExecutionEvent {
	readonly sequence: number;
	readonly type:
		| 'run.started'
		| 'provider.started'
		| 'provider.output.delta'
		| 'tool.started'
		| 'tool.completed'
		| 'tool.failed'
		| 'tool.denied'
		| 'tool.native'
		| 'provider.completed'
		| 'run.completed';
	readonly timestamp: number;
	readonly message: string;
	readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface AgentUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
}

export interface AgentProviderResult {
	readonly output: string;
	readonly structuredOutput?: JsonValue;
	readonly usage: AgentUsage;
	readonly finishReason: 'stop' | 'length' | 'tool-limit';
}

export interface AgentToolContext {
	readonly runId: string;
	readonly tenantId: string;
	readonly requestedBy: string;
	/* Present for real agent runs. Optional keeps direct module tests and action
	   execution source-compatible while callers that need an agent actor can
	   refuse when the trusted identity is absent. */
	readonly agentId?: string;
	readonly agentName?: string;
	/* How the tool was reached: a model turn inside an agent run, or a workflow
	   node running it as a published action. A tool whose admission differs per
	   caller kind reads this instead of assuming one. Optional keeps v1 callers
	   and direct module tests source-compatible; absent means an agent run,
	   because the workflow action runtime always states it. */
	readonly invocation?: 'agent-run' | 'workflow-action';
	readonly idempotencyKey?: string;
	/* Trusted provenance for record history. Optional preserves v1 direct tool
	   callers; harness and workflow executions always provide it. */
	readonly actor?: Actor;
	readonly authorizationSubject?: UserActor;
	readonly permissions: ReadonlySet<string>;
	readonly signal: AbortSignal;
}

export interface AgentToolConsentDecision {
	readonly granted: boolean;
	/** Stable code recorded on the denial event when the gate refuses. */
	readonly reason?: string;
}

/**
 * A module-owned gate asked before every call of a tool that declares one, so
 * a workspace can admit a tool per record (a connector instance an owner
 * consented to) without the tool declaring a risk the harness refuses outright.
 * The answer is computed per call from the already validated input and is never
 * cached; a gate that throws denies.
 */
export interface AgentToolConsent {
	/** Stable id of the gate, recorded on the denial event. */
	readonly id: string;
	check(
		input: unknown,
		context: AgentToolContext,
	): Promise<AgentToolConsentDecision> | AgentToolConsentDecision;
}

export interface AgentTool {
	readonly id: string;
	readonly transport: 'api' | 'cli';
	readonly target: string;
	readonly description: string;
	readonly requiredPermissions: readonly string[];
	readonly inputSchema?: Readonly<Record<string, unknown>>;
	readonly contractVersion?: number;
	readonly outputSchema?: Readonly<Record<string, unknown>>;
	readonly risk?: 'read' | 'workspace-write' | 'external' | 'destructive';
	/* A CLI capability the runner admits in development and test only. The
	   harness reads FD_ENV or NODE_ENV the way the runner does and refuses it
	   elsewhere, grant or not. */
	readonly localOnly?: boolean;
	/* Run-time admission on top of the permission snapshot. A tool declaring one
	   is offered to the model as usual and refused per call when the gate says so. */
	readonly consent?: AgentToolConsent;
	readonly idempotency?: 'required';
	/* A mutating tool is executable only when its target persists the key and
	   returns the first result on retry. Declaring `required` alone is not that
	   guarantee. */
	readonly idempotencyProtection?: 'target-ledger';
	readonly cancellation?: 'cooperative' | 'not-supported';
	/* Per call. Defaults to 30 s; the run's own timeout still applies. */
	readonly timeoutMs?: number;
	execute(input: unknown, context: AgentToolContext): Promise<unknown>;
}

export const AGENT_NATIVE_TOOL_KINDS = ['web-search'] as const;
export type AgentNativeToolKind = (typeof AGENT_NATIVE_TOOL_KINDS)[number];

/** The stable reason a provider reports for a native tool it cannot pass on. */
export const NATIVE_TOOL_UNSUPPORTED = 'NATIVE_TOOL_UNSUPPORTED';

export const NATIVE_TOOL_LIMITS = {
	resultsPerReport: 32,
	reportsPerRun: 16,
	url: 2_048,
	title: 300,
	snippet: 1_000,
	source: 200,
	publishedAt: 64,
	query: 400,
	configCharacters: 8_192,
} as const;

/** One citation a provider-executed search returned. */
export interface AgentNativeResult {
	readonly url: string;
	readonly title: string;
	readonly snippet: string;
	readonly publishedAt?: string;
	readonly source: string;
}

export type AgentNativeReport =
	| {
			readonly id: string;
			readonly query?: string;
			readonly results: readonly AgentNativeResult[];
	  }
	| { readonly id: string; readonly code: typeof NATIVE_TOOL_UNSUPPORTED };

/**
 * A tool the model provider executes on its own side, such as a web search.
 * The harness never runs it: it decides whether the run is offered the tool,
 * hands the provider its configuration, and passes the citations the provider
 * reports to `record` after bounding them.
 */
export interface AgentNativeTool {
	readonly id: string;
	readonly kind: AgentNativeToolKind;
	readonly config: Readonly<Record<string, unknown>>;
	readonly requiredPermissions: readonly string[];
	/* Asked once, when the run starts, because the provider runs the tool
	   without asking the harness again. Input is always undefined. */
	readonly consent?: AgentToolConsent;
	/* Per-run configuration merged over `config`, for example a workspace's
	   domain lists. A throw withholds the tool from the run. */
	resolveConfig?(
		context: AgentToolContext,
	):
		| Readonly<Record<string, unknown>>
		| Promise<Readonly<Record<string, unknown>>>;
	/* Receives the bounded citations of one provider report. A throw is recorded
	   as a failure event and never fails the run. */
	record?(
		report: {
			readonly query: string | null;
			readonly results: readonly AgentNativeResult[];
		},
		context: AgentToolContext,
	): Promise<void>;
}

export interface AgentProviderNativeTool {
	readonly id: string;
	readonly kind: AgentNativeToolKind;
	readonly config: Readonly<Record<string, unknown>>;
}

export interface AgentProviderContext {
	readonly request: AgentExecutionRequest;
	readonly signal: AbortSignal;
	readonly availableTools: readonly {
		readonly id: string;
		readonly transport: 'api' | 'cli';
		readonly target: string;
		readonly description: string;
		readonly inputSchema: Readonly<Record<string, unknown>>;
	}[];
	/** Provider-executed tools this run was granted and admitted to. */
	readonly nativeTools: readonly AgentProviderNativeTool[];
	invokeTool(
		id: string,
		input: unknown,
		invocation?: { readonly providerCallId?: string },
	): Promise<unknown>;
	/**
	 * Reports what a native tool returned, or that this provider cannot pass it
	 * on. Recorded on the run as a `tool.native` event; a report for a tool the
	 * run was not offered is denied.
	 */
	reportNative(report: AgentNativeReport): Promise<void>;
	emit(
		type: AgentExecutionEvent['type'],
		message: string,
		metadata?: Readonly<Record<string, string | number | boolean>>,
	): void;
}

export interface AgentProvider {
	readonly id: string;
	readonly capabilities?: {
		readonly structuredOutput: boolean;
	};
	execute(context: AgentProviderContext): Promise<AgentProviderResult>;
}

export interface AgentExecutionResult extends AgentProviderResult {
	readonly events: readonly AgentExecutionEvent[];
	readonly startedAt: number;
	readonly completedAt: number;
}

export interface AgentToolAuthorizationRequest {
	readonly tenantId: string;
	readonly actor: Actor;
	readonly signal: AbortSignal;
}

export type AgentToolAccessAuthorizer = (
	request: AgentToolAuthorizationRequest,
) => readonly string[] | Promise<readonly string[]>;

function identifier(value: string, field: string): string {
	const normalized = value.trim();
	if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(normalized)) {
		throw new AgentHarnessError(
			'INVALID_IDENTIFIER',
			`${field} must be a lowercase dot-separated identifier.`,
		);
	}
	return normalized;
}

function boundedText(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
): string {
	const normalized = value.trim();
	if (normalized.length < minimum || normalized.length > maximum) {
		throw new AgentHarnessError(
			'INVALID_INPUT',
			`${field} must contain between ${minimum} and ${maximum} characters.`,
		);
	}
	return normalized;
}

/** Opaque connection IDs may contain generated numeric segments. Authority
 * comes from provider resolution and the exact snapshot match, not this syntax. */
function providerReference(value: string): string {
	const normalized = boundedText(value, 'provider', 1, 128);
	if (/[\u0000-\u001f\u007f]/.test(normalized)) {
		throw new AgentHarnessError(
			'INVALID_INPUT',
			'provider contains an unsupported character.',
		);
	}
	return normalized;
}

function assertExecutionRequest(request: AgentExecutionRequest): void {
	boundedText(request.runId, 'runId', 1, 128);
	boundedText(request.tenantId, 'tenantId', 1, 128);
	const requestedBy = boundedText(request.requestedBy, 'requestedBy', 1, 128);
	const requestedActor = normalizeActor(request.requestedActor);
	if (!requestedActor || requestedActor.id !== requestedBy) {
		throw new AgentHarnessError(
			'INVALID_ACTOR',
			'requestedActor must be valid and match requestedBy.',
		);
	}
	const suppliedSubject = request.authorizationSubject
		? normalizeActor(request.authorizationSubject)
		: undefined;
	const derivedSubject =
		requestedActor.kind === 'user'
			? requestedActor
			: requestedActor.kind === 'service'
				? requestedActor.configuredBy
				: undefined;
	if (
		(suppliedSubject != null && suppliedSubject.kind !== 'user') ||
		(derivedSubject !== undefined &&
			suppliedSubject != null &&
			derivedSubject.id !== suppliedSubject.id)
	) {
		throw new AgentHarnessError(
			'INVALID_AUTHORIZATION_SUBJECT',
			'authorizationSubject must be the trusted delegated user.',
		);
	}
	boundedText(request.input, 'input', 1, 100_000);
	if (
		request.nativeFixturesPath !== undefined &&
		(typeof request.nativeFixturesPath !== 'string' ||
			request.nativeFixturesPath.length > 1_024 ||
			!isAbsolute(request.nativeFixturesPath) ||
			basename(request.nativeFixturesPath) !== 'research-fixtures.json')
	) {
		throw new AgentHarnessError(
			'INVALID_INPUT',
			'nativeFixturesPath must be an absolute path to a research-fixtures.json file.',
		);
	}
	if (request.grants !== undefined) {
		if (
			!Array.isArray(request.grants) ||
			request.grants.length > MAX_APPROVAL_GRANTS ||
			request.grants.some(
				(grant) =>
					typeof grant !== 'string' ||
					grant.length < 1 ||
					grant.length > APPROVAL_GRANT_MAX_TOKEN_LENGTH,
			)
		) {
			throw new AgentHarnessError(
				'INVALID_INPUT',
				`grants must be at most ${MAX_APPROVAL_GRANTS} tokens of at most ${APPROVAL_GRANT_MAX_TOKEN_LENGTH} characters.`,
			);
		}
	}
	boundedText(request.definition.name, 'definition.name', 2, 120);
	boundedText(request.definition.instructions, 'instructions', 8, 40_000);
	providerReference(request.definition.provider);
	boundedText(request.definition.model, 'model', 1, 160);
	if (
		!Number.isSafeInteger(request.definition.revision) ||
		request.definition.revision < 1
	) {
		throw new AgentHarnessError(
			'INVALID_REVISION',
			'definition.revision must be a positive integer.',
		);
	}
	if (
		!Number.isSafeInteger(request.definition.maxSteps) ||
		request.definition.maxSteps < 1 ||
		request.definition.maxSteps > 32
	) {
		throw new AgentHarnessError(
			'INVALID_MAX_STEPS',
			'definition.maxSteps must be between 1 and 32.',
		);
	}
	if (
		!Number.isSafeInteger(request.definition.timeoutMs) ||
		request.definition.timeoutMs < 250 ||
		request.definition.timeoutMs > 86_400_000
	) {
		throw new AgentHarnessError(
			'INVALID_TIMEOUT',
			'definition.timeoutMs must be between 250 and 86400000.',
		);
	}
	if (
		!Number.isFinite(request.definition.temperature) ||
		request.definition.temperature < 0 ||
		request.definition.temperature > 2
	) {
		throw new AgentHarnessError(
			'INVALID_TEMPERATURE',
			'definition.temperature must be between 0 and 2.',
		);
	}
	const maxOutputTokens = request.definition.maxOutputTokens;
	if (
		maxOutputTokens !== undefined &&
		(!Number.isSafeInteger(maxOutputTokens) ||
			maxOutputTokens < MIN_MAX_OUTPUT_TOKENS ||
			maxOutputTokens > MAX_MAX_OUTPUT_TOKENS)
	) {
		throw new AgentHarnessError(
			'INVALID_MAX_OUTPUT_TOKENS',
			`definition.maxOutputTokens must be between ${MIN_MAX_OUTPUT_TOKENS} and ${MAX_MAX_OUTPUT_TOKENS}.`,
		);
	}
	if (request.outputContract?.kind === 'json-schema') {
		boundedText(request.outputContract.name, 'outputContract.name', 1, 64);
		if (
			!request.outputContract.schema ||
			Array.isArray(request.outputContract.schema) ||
			typeof request.outputContract.schema !== 'object'
		) {
			throw new AgentHarnessError(
				'INVALID_OUTPUT_CONTRACT',
				'outputContract.schema must be a JSON object.',
			);
		}
		validateJsonValue(
			request.outputContract.schema,
			'INVALID_OUTPUT_CONTRACT',
			'outputContract.schema',
		);
		let serialized: string;
		try {
			serialized = JSON.stringify(request.outputContract.schema);
		} catch {
			throw new AgentHarnessError(
				'INVALID_OUTPUT_CONTRACT',
				'outputContract.schema must be JSON serializable.',
			);
		}
		if (serialized.length > 32_768) {
			throw new AgentHarnessError(
				'INVALID_OUTPUT_CONTRACT',
				'outputContract.schema exceeds 32768 characters.',
			);
		}
	}
}

function toolFailure(error: unknown): { code: string; message: string } {
	if (error instanceof AgentHarnessError) {
		return { code: error.code, message: error.message };
	}
	const message =
		error instanceof Error && error.message
			? error.message.slice(0, 300)
			: 'The tool failed.';
	return { code: 'TOOL_EXECUTION_FAILED', message };
}

/**
 * `external` is the ceiling no unattended caller crosses on its own: the CLI
 * runner, `defineCliAgentTool` for a destructive capability, and a hand-built
 * tool object here all run only under a signed approval grant naming the tool
 * and the input, before the model is ever told the tool exists.
 */
function requiresApprovalGrant(tool: AgentTool): boolean {
	return (
		tool.risk === 'external' ||
		(tool.risk === 'destructive' && tool.transport === 'cli')
	);
}

type GrantRefusal = ApprovalGrantReason | 'APPROVAL_GRANT_CONSUMED';

interface RunApprovalGrants {
	/** Tokens that verify for this tenant, by the tool id they name. */
	readonly byTool: ReadonlyMap<string, readonly string[]>;
	/** Why the first refused token was refused, per tool, for the denial event. */
	readonly refusals: ReadonlyMap<string, GrantRefusal>;
}

/* The same reading the CLI runner applies to a localOnly capability. */
function localOnlyRefused(tool: AgentTool): boolean {
	const environment =
		process.env.FD_ENV ?? process.env.NODE_ENV ?? 'development';
	return (
		tool.localOnly === true &&
		environment !== 'development' &&
		environment !== 'test'
	);
}

/* Signature, key and tenant are settled once per run; the input digest is
   settled per call, because the model chooses the input. A token that is
   invalid or expired is so for every tool, and is recorded against each. */
function runApprovalGrants(
	keyring: ApprovalGrantKeyring | undefined,
	request: AgentExecutionRequest,
	tools: ReadonlyMap<string, AgentTool>,
): RunApprovalGrants {
	const byTool = new Map<string, string[]>();
	const refusals = new Map<string, GrantRefusal>();
	if (!keyring) return { byTool, refusals };
	const gated = [...tools.values()].filter(requiresApprovalGrant);
	for (const token of request.grants ?? []) {
		let reason: ApprovalGrantReason = 'APPROVAL_GRANT_MISMATCH';
		let matched = false;
		for (const tool of gated) {
			const verified = verifyApprovalGrant(keyring, token, {
				tenantId: request.tenantId,
				capabilityId: tool.id,
			});
			if (verified.ok) {
				byTool.set(tool.id, [...(byTool.get(tool.id) ?? []), token]);
				matched = true;
				break;
			}
			reason = verified.reason;
			if (reason !== 'APPROVAL_GRANT_MISMATCH') break;
		}
		/* A token that verifies for no tool is refused for every gated tool: it
		   was signed for another tenant or capability, or not by this platform. */
		if (!matched) {
			for (const other of gated) {
				if (!refusals.has(other.id)) refusals.set(other.id, reason);
			}
		}
	}
	return { byTool, refusals };
}

function nativeText(value: unknown, maximum: number): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
	return normalized.slice(0, maximum);
}

/* Provider output is foreign data: an entry without a usable http(s) URL is
   dropped, and every text field is cut to its bound rather than refused, so
   one long title never costs the run its other citations. */
function boundNativeResults(results: unknown): {
	readonly results: readonly AgentNativeResult[];
	readonly dropped: number;
} {
	const entries = Array.isArray(results) ? results : [];
	const accepted: AgentNativeResult[] = [];
	for (const entry of entries) {
		if (accepted.length >= NATIVE_TOOL_LIMITS.resultsPerReport) break;
		const value = (entry ?? {}) as Record<string, unknown>;
		const url = typeof value.url === 'string' ? value.url.trim() : '';
		let parsed: URL | null = null;
		try {
			parsed = url.length <= NATIVE_TOOL_LIMITS.url ? new URL(url) : null;
		} catch {
			parsed = null;
		}
		if (
			!parsed ||
			(parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
			parsed.toString().length > NATIVE_TOOL_LIMITS.url
		) {
			continue;
		}
		const publishedAt = nativeText(
			value.publishedAt,
			NATIVE_TOOL_LIMITS.publishedAt,
		);
		accepted.push({
			url: parsed.toString(),
			title: nativeText(value.title, NATIVE_TOOL_LIMITS.title) ?? '',
			snippet: nativeText(value.snippet, NATIVE_TOOL_LIMITS.snippet) ?? '',
			source:
				nativeText(value.source, NATIVE_TOOL_LIMITS.source) ?? parsed.hostname,
			...(publishedAt ? { publishedAt } : {}),
		});
	}
	return { results: accepted, dropped: entries.length - accepted.length };
}

function nativeConfig(
	value: unknown,
	field: string,
): Readonly<Record<string, unknown>> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new AgentHarnessError(
			'INVALID_NATIVE_TOOL',
			`${field} must be a JSON object.`,
		);
	}
	validateJsonValue(value, 'INVALID_NATIVE_TOOL', field);
	if (JSON.stringify(value).length > NATIVE_TOOL_LIMITS.configCharacters) {
		throw new AgentHarnessError(
			'INVALID_NATIVE_TOOL',
			`${field} exceeds ${NATIVE_TOOL_LIMITS.configCharacters} characters.`,
		);
	}
	return value as Readonly<Record<string, unknown>>;
}

/* A refusal code comes from module code, so it is bounded to the shape an
   event metadata field may carry before it is recorded. */
function consentReason(reason: string | undefined): string {
	return reason !== undefined && /^[A-Z][A-Z0-9_]{2,63}$/.test(reason)
		? reason
		: 'TOOL_CONSENT_REFUSED';
}

/**
 * The narrow tracing port the harness needs, declared here rather than
 * imported: `@flowdular/server` is a sibling package, not a dependency of the
 * harness, and its tracer satisfies this shape structurally. The composer that
 * owns both hands one in; without it the harness records nothing and pays one
 * optional call per provider and per tool.
 */
export interface AgentTraceContext {
	readonly traceId: string;
	readonly spanId: string;
	readonly sampled: boolean;
}

export interface AgentTraceSpan {
	readonly context: AgentTraceContext;
	setAttribute(key: string, value: string | number | boolean): void;
	end(status?: 'unset' | 'ok' | 'error', message?: string): void;
}

export interface AgentSpanOptions {
	readonly parent?: AgentTraceContext | null;
	readonly kind?: 'internal' | 'client';
	readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface AgentTracer {
	startSpan(name: string, options?: AgentSpanOptions): AgentTraceSpan;
}

/* Foreign code on the run path: a tracer that throws must cost the run
   nothing, so both ends answer with an absent span instead of raising. */
function startSpan(
	tracer: AgentTracer | undefined,
	name: string,
	options: AgentSpanOptions,
): AgentTraceSpan | undefined {
	if (!tracer) return undefined;
	try {
		return tracer.startSpan(name, options);
	} catch {
		return undefined;
	}
}

function endSpan(
	span: AgentTraceSpan | undefined,
	status: 'ok' | 'error',
	message?: string,
): void {
	if (!span) return;
	try {
		span.end(status, message);
	} catch {
		/* An observer that throws is the observer's defect, not the run's. */
	}
}

export class AgentHarness {
	readonly #providers: ReadonlyMap<string, AgentProvider>;
	readonly #tools: ReadonlyMap<string, AgentTool>;
	readonly #nativeTools: ReadonlyMap<string, AgentNativeTool>;
	readonly #authorizeToolAccess: AgentToolAccessAuthorizer;
	readonly #tracer: AgentTracer | undefined;
	readonly #approvalGrants: ApprovalGrantKeyring | undefined;

	constructor(options: {
		readonly providers: readonly AgentProvider[];
		readonly tools?: readonly AgentTool[];
		readonly nativeTools?: readonly AgentNativeTool[];
		readonly authorizeToolAccess?: AgentToolAccessAuthorizer;
		readonly tracer?: AgentTracer;
		/* Verifies the approval grants a run carries. Absent reads
		   FD_APPROVAL_GRANT_KEY; without either, no external tool ever runs. */
		readonly approvalGrants?: ApprovalGrantKeyring;
	}) {
		const providers = new Map<string, AgentProvider>();
		for (const provider of options.providers) {
			const id = providerReference(provider.id);
			if (providers.has(id)) {
				throw new AgentHarnessError(
					'DUPLICATE_PROVIDER',
					`Provider ${id} is already registered.`,
				);
			}
			providers.set(id, provider);
		}
		const tools = new Map<string, AgentTool>();
		for (const tool of options.tools ?? []) {
			const id = identifier(tool.id, 'tool.id');
			if (tools.has(id)) {
				throw new AgentHarnessError(
					'DUPLICATE_TOOL',
					`Tool ${id} is already registered.`,
				);
			}
			/* The gate id reaches the denial event, so it is held to the same
			   shape as the tool id rather than checked only where it is emitted. */
			if (tool.consent) identifier(tool.consent.id, 'tool.consent.id');
			toolTimeoutMs(tool.timeoutMs);
			tools.set(id, tool);
		}
		/* One id space: a grant names a tool or a native tool, never both. */
		const nativeTools = new Map<string, AgentNativeTool>();
		for (const tool of options.nativeTools ?? []) {
			const id = identifier(tool.id, 'nativeTool.id');
			if (tools.has(id) || nativeTools.has(id)) {
				throw new AgentHarnessError(
					'DUPLICATE_TOOL',
					`Tool ${id} is already registered.`,
				);
			}
			if (!AGENT_NATIVE_TOOL_KINDS.includes(tool.kind)) {
				throw new AgentHarnessError(
					'INVALID_NATIVE_TOOL',
					`Native tool ${id} declares an unknown kind.`,
				);
			}
			if (tool.consent) identifier(tool.consent.id, 'nativeTool.consent.id');
			nativeConfig(tool.config, `Native tool ${id} config`);
			nativeTools.set(id, tool);
		}
		this.#providers = providers;
		this.#tools = tools;
		this.#nativeTools = nativeTools;
		/* No callback means no live authority. This keeps standalone runtimes and
		   service actors fail-closed instead of treating a stored snapshot as a
		   permanent credential. */
		this.#authorizeToolAccess = options.authorizeToolAccess ?? (() => []);
		this.#tracer = options.tracer;
		this.#approvalGrants =
			options.approvalGrants ?? approvalGrantKeyringFromEnvironment();
	}

	providers(): readonly string[] {
		return [...this.#providers.keys()].sort();
	}

	providerSupportsStructuredOutput(id: string): boolean {
		return this.#providers.get(id)?.capabilities?.structuredOutput === true;
	}

	/* Native tool ids are listed with the rest: an agent definition allows and a
	   run grants them by the same exact id. */
	tools(): readonly string[] {
		return [...this.#tools.keys(), ...this.#nativeTools.keys()].sort();
	}

	nativeTools(): readonly string[] {
		return [...this.#nativeTools.keys()].sort();
	}

	/* This is the single access calculation used both when a durable run is
	   created and when it is executed. A tool must be present in the code
	   registry, allowed by the agent, explicitly requested for the run, and
	   covered by the trusted permission snapshot. */
	effectiveToolGrants(
		allowedTools: readonly string[],
		requestedToolGrants: readonly string[],
		permissionSnapshot: readonly string[],
	): readonly string[] {
		const allowed = new Set(allowedTools);
		const requested = new Set(requestedToolGrants);
		const permissions = new Set(permissionSnapshot);
		return [...this.#tools.values(), ...this.#nativeTools.values()]
			.filter((tool) => allowed.has(tool.id) && requested.has(tool.id))
			.filter((tool) =>
				tool.requiredPermissions.every((permission) =>
					permissions.has(permission),
				),
			)
			.map((tool) => tool.id)
			.sort();
	}

	async execute(
		request: AgentExecutionRequest,
		options: {
			readonly onEvent?: (event: AgentExecutionEvent) => void;
			readonly provider?: AgentProvider;
			readonly signal?: AbortSignal;
		} = {},
	): Promise<AgentExecutionResult> {
		assertExecutionRequest(request);
		const auditActor = normalizeActor(request.requestedActor)!;
		const authorizationSubject = request.authorizationSubject
			? normalizeActor(request.authorizationSubject)
			: auditActor.kind === 'user'
				? auditActor
				: auditActor.kind === 'service'
					? auditActor.configuredBy
					: null;
		const provider =
			options.provider ?? this.#providers.get(request.definition.provider);
		if (!provider) {
			throw new AgentHarnessError(
				'PROVIDER_NOT_AVAILABLE',
				`Provider ${request.definition.provider} is not registered.`,
			);
		}
		if (provider.id !== request.definition.provider) {
			throw new AgentHarnessError(
				'PROVIDER_MISMATCH',
				'The resolved provider does not match the run snapshot.',
			);
		}
		const outputContract = request.outputContract ?? { kind: 'text' as const };
		if (
			outputContract.kind === 'json-schema' &&
			provider.capabilities?.structuredOutput !== true
		) {
			throw new AgentHarnessError(
				'STRUCTURED_OUTPUT_UNSUPPORTED',
				`Provider ${provider.id} cannot guarantee structured output for this run.`,
			);
		}
		const snapshotGrants = new Set(
			this.effectiveToolGrants(
				request.definition.allowedTools,
				request.toolGrants,
				request.permissionSnapshot,
			),
		);
		const controller = new AbortController();
		const abortFromCaller = () =>
			controller.abort(options.signal?.reason ?? 'aborted');
		if (options.signal?.aborted) abortFromCaller();
		else
			options.signal?.addEventListener('abort', abortFromCaller, {
				once: true,
			});
		const livePermissions = async (): Promise<Set<string>> => {
			if (!authorizationSubject || authorizationSubject.kind !== 'user') {
				return new Set();
			}
			let authorized: readonly string[];
			try {
				authorized = await this.#authorizeToolAccess({
					tenantId: request.tenantId,
					actor: authorizationSubject,
					signal: controller.signal,
				});
			} catch {
				throw new AgentHarnessError(
					'TOOL_AUTHORIZATION_FAILED',
					'Live tool authorization is unavailable.',
				);
			}
			const currentlyHeld = new Set(authorized);
			return new Set(
				request.permissionSnapshot.filter((permission) =>
					currentlyHeld.has(permission),
				),
			);
		};
		const initialPermissions = await livePermissions();
		const grantKeyring = this.#approvalGrants;
		const approvals = runApprovalGrants(grantKeyring, request, this.#tools);
		const admissible = (tool: AgentTool): boolean =>
			!localOnlyRefused(tool) &&
			(!requiresApprovalGrant(tool) || approvals.byTool.has(tool.id));
		/* One call per grant: a request approved once admits one invocation of
		   the tool it names, however many times the model asks. */
		const consumedGrants = new Set<string>();
		const availableTools = [...this.#tools.values()]
			.filter((tool) => snapshotGrants.has(tool.id))
			.filter(admissible)
			.filter((tool) =>
				tool.requiredPermissions.every((permission) =>
					initialPermissions.has(permission),
				),
			)
			.sort((left, right) => left.id.localeCompare(right.id));
		const startedAt = Date.now();
		const events: AgentExecutionEvent[] = [];
		let acceptingEvents = true;
		const emit: AgentProviderContext['emit'] = (type, message, metadata) => {
			if (!acceptingEvents) return;
			/* Streamed output deltas are kept verbatim: a whitespace-only chunk
			   carries formatting and must not fail the run. */
			const text =
				type === 'provider.output.delta'
					? message.slice(0, 500)
					: boundedText(message, 'event.message', 1, 500);
			if (text.length === 0) return;
			const event: AgentExecutionEvent = {
				sequence: events.length + 1,
				type,
				timestamp: Date.now(),
				message: text,
				...(metadata === undefined ? {} : { metadata }),
			};
			events.push(event);
			options.onEvent?.(event);
		};
		emit('run.started', 'Harness accepted the claimed run.');
		emit('provider.started', `Provider ${provider.id} started.`, {
			model: request.definition.model,
		});
		const grantedIds = new Set(availableTools.map((tool) => tool.id));
		const nativeContext = (
			permissions: ReadonlySet<string>,
		): AgentToolContext => ({
			runId: request.runId,
			tenantId: request.tenantId,
			requestedBy: request.requestedBy,
			agentId: request.definition.id,
			agentName: request.definition.name,
			invocation: 'agent-run',
			actor: {
				kind: 'agent',
				id: request.definition.id,
				label: request.definition.name,
				runId: request.runId,
			},
			...(authorizationSubject?.kind === 'user'
				? { authorizationSubject }
				: {}),
			permissions,
			signal: controller.signal,
		});
		const offeredNative = new Map<
			string,
			{
				readonly tool: AgentNativeTool;
				readonly config: Readonly<Record<string, unknown>>;
			}
		>();
		/* Settled once, before the provider starts: the provider runs a native
		   tool on its own side and never comes back to ask. */
		const offerNativeTools = async (): Promise<void> => {
			const candidates = [...this.#nativeTools.values()]
				.filter((tool) => snapshotGrants.has(tool.id))
				.filter((tool) =>
					tool.requiredPermissions.every((permission) =>
						initialPermissions.has(permission),
					),
				)
				.sort((left, right) => left.id.localeCompare(right.id));
			for (const tool of candidates) {
				const context = nativeContext(initialPermissions);
				if (tool.consent) {
					let decision: AgentToolConsentDecision;
					try {
						decision = await tool.consent.check(undefined, context);
					} catch {
						decision = { granted: false, reason: 'TOOL_CONSENT_UNAVAILABLE' };
					}
					if (!decision.granted) {
						emit('tool.denied', `Tool ${tool.id} was denied.`, {
							tool: tool.id,
							consent: tool.consent.id,
							reason: consentReason(decision.reason),
						});
						continue;
					}
				}
				let config = tool.config;
				if (tool.resolveConfig) {
					try {
						config = {
							...tool.config,
							...nativeConfig(
								await tool.resolveConfig(context),
								`Native tool ${tool.id} config`,
							),
						};
					} catch {
						emit('tool.denied', `Tool ${tool.id} was denied.`, {
							tool: tool.id,
							reason: 'NATIVE_CONFIG_UNAVAILABLE',
						});
						continue;
					}
				}
				offeredNative.set(tool.id, { tool, config });
			}
		};
		const nativeReports = new Map<string, number>();
		const reportNative = async (report: AgentNativeReport): Promise<void> => {
			/* A report after the run settled or was aborted would write evidence
			   for a run that no longer accepts events. */
			if (!acceptingEvents || controller.signal.aborted) {
				throw new AgentHarnessError(
					'EXECUTION_ABORTED',
					'The run no longer accepts native tool reports.',
				);
			}
			const id = String(report?.id ?? '').slice(0, 128);
			const offered = offeredNative.get(id);
			if (!offered) {
				emit('tool.denied', `Tool ${id || 'unknown'} was denied.`, {
					tool: id || 'unknown',
					reason: 'TOOL_NOT_GRANTED',
				});
				throw new AgentHarnessError(
					'TOOL_NOT_GRANTED',
					`Native tool ${id || 'unknown'} was not granted for this run.`,
				);
			}
			const reports = (nativeReports.get(id) ?? 0) + 1;
			nativeReports.set(id, reports);
			if (reports > NATIVE_TOOL_LIMITS.reportsPerRun) {
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: 'NATIVE_REPORT_LIMIT',
				});
				throw new AgentHarnessError(
					'NATIVE_REPORT_LIMIT',
					`Native tool ${id} may report at most ${NATIVE_TOOL_LIMITS.reportsPerRun} times in one run.`,
				);
			}
			if ('code' in report) {
				emit('tool.native', `Native tool ${id} is not supported here.`, {
					tool: id,
					reason: NATIVE_TOOL_UNSUPPORTED,
				});
				return;
			}
			let permissions: Set<string>;
			try {
				permissions = await livePermissions();
			} catch (error) {
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: toolFailure(error).code,
				});
				throw error;
			}
			if (
				offered.tool.requiredPermissions.some(
					(permission) => !permissions.has(permission),
				)
			) {
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: 'TOOL_AUTHORIZATION_REVOKED',
				});
				throw new AgentHarnessError(
					'TOOL_AUTHORIZATION_REVOKED',
					`The initiating actor no longer has permission for tool ${id}.`,
				);
			}
			const bounded = boundNativeResults(report.results);
			emit(
				'tool.native',
				`Native tool ${id} reported ${bounded.results.length} results.`,
				{
					tool: id,
					results: bounded.results.length,
					...(bounded.dropped > 0 ? { dropped: bounded.dropped } : {}),
				},
			);
			if (!offered.tool.record) return;
			try {
				await offered.tool.record(
					{
						query: nativeText(report.query, NATIVE_TOOL_LIMITS.query) || null,
						results: bounded.results,
					},
					nativeContext(permissions),
				);
			} catch (error) {
				emit('tool.failed', `Tool ${id} failed.`, {
					tool: id,
					reason: toolFailure(error).code,
				});
			}
		};
		const tracer = this.#tracer;
		let providerSpan: AgentTraceSpan | undefined;
		let toolCallOrdinal = 0;
		const invokeTool = async (
			id: string,
			input: unknown,
			invocation: { readonly providerCallId?: string } = {},
		): Promise<unknown> => {
			const ordinal = ++toolCallOrdinal;
			const tool = this.#tools.get(id);
			if (tool && localOnlyRefused(tool)) {
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: 'TOOL_LOCAL_ONLY',
				});
				throw new AgentHarnessError(
					'TOOL_LOCAL_ONLY',
					`Tool ${id} is a local-only capability and cannot run in this environment.`,
				);
			}
			if (tool && !admissible(tool)) {
				const refusal = approvals.refusals.get(id);
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: 'TOOL_RISK_REFUSED',
					...(refusal ? { grant: refusal } : {}),
				});
				throw new AgentHarnessError(
					'TOOL_RISK_REFUSED',
					`Tool ${id} declares ${tool.risk} risk and runs only under an approval grant.`,
				);
			}
			if (!tool || !grantedIds.has(id)) {
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: 'TOOL_NOT_GRANTED',
				});
				throw new AgentHarnessError(
					'TOOL_NOT_GRANTED',
					`Tool ${id} was not granted for this run.`,
				);
			}
			let permissions: Set<string>;
			try {
				permissions = await livePermissions();
			} catch (error) {
				const failure = toolFailure(error);
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: failure.code,
				});
				throw error;
			}
			if (
				tool.requiredPermissions.some(
					(permission) => !permissions.has(permission),
				)
			) {
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: 'TOOL_AUTHORIZATION_REVOKED',
				});
				throw new AgentHarnessError(
					'TOOL_AUTHORIZATION_REVOKED',
					`The initiating actor no longer has permission for tool ${id}.`,
				);
			}
			if (
				tool.risk !== undefined &&
				tool.risk !== 'read' &&
				tool.idempotency === 'required' &&
				tool.idempotencyProtection !== 'target-ledger'
			) {
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: 'TOOL_IDEMPOTENCY_UNAVAILABLE',
				});
				throw new AgentHarnessError(
					'TOOL_IDEMPOTENCY_UNAVAILABLE',
					`Tool ${id} has no durable target-side idempotency guarantee.`,
				);
			}
			let idempotencyKey: string | undefined;
			if (tool.idempotency === 'required') {
				/* Provider call ids are useful evidence but are not guaranteed to be
				   reproduced after a process crash. The run id and call ordinal are. */
				idempotencyKey = createHash('sha256')
					.update(`${request.runId}\u0000${ordinal}`)
					.digest('hex');
			}
			try {
				validateToolInput(tool.inputSchema, input);
			} catch (error) {
				const failure = toolFailure(error);
				emit('tool.denied', `Tool ${id} was denied.`, {
					tool: id,
					reason: failure.code,
				});
				throw error;
			}
			if (requiresApprovalGrant(tool)) {
				const expected = {
					tenantId: request.tenantId,
					capabilityId: id,
					inputDigest: approvalInputDigest(input),
				};
				let refusal: GrantRefusal = 'APPROVAL_GRANT_MISMATCH';
				const admitted =
					grantKeyring !== undefined &&
					(approvals.byTool.get(id) ?? []).some((token) => {
						const verified = verifyApprovalGrant(grantKeyring, token, expected);
						if (!verified.ok) {
							refusal = verified.reason;
							return false;
						}
						if (consumedGrants.has(verified.claims.requestId)) {
							refusal = 'APPROVAL_GRANT_CONSUMED';
							return false;
						}
						consumedGrants.add(verified.claims.requestId);
						return true;
					});
				if (!admitted) {
					emit('tool.denied', `Tool ${id} was denied.`, {
						tool: id,
						reason: 'TOOL_RISK_REFUSED',
						grant: refusal,
					});
					throw new AgentHarnessError(
						'TOOL_RISK_REFUSED',
						`Tool ${id} has no approval grant for this input.`,
					);
				}
			}
			if (tool.consent) {
				/* Foreign code: a throw is a refusal, never a crash. The run deadline
				   already bounds it, because the provider call this runs inside races
				   the execution timeout. */
				let decision: AgentToolConsentDecision;
				try {
					decision = await tool.consent.check(input, {
						runId: request.runId,
						tenantId: request.tenantId,
						requestedBy: request.requestedBy,
						agentId: request.definition.id,
						agentName: request.definition.name,
						invocation: 'agent-run',
						actor: {
							kind: 'agent',
							id: request.definition.id,
							label: request.definition.name,
							runId: request.runId,
						},
						...(authorizationSubject?.kind === 'user'
							? { authorizationSubject }
							: {}),
						permissions,
						signal: controller.signal,
					});
				} catch {
					decision = { granted: false, reason: 'TOOL_CONSENT_UNAVAILABLE' };
				}
				if (!decision.granted) {
					const reason = consentReason(decision.reason);
					emit('tool.denied', `Tool ${id} was denied.`, {
						tool: id,
						consent: tool.consent.id,
						reason,
					});
					throw new AgentHarnessError(
						reason,
						`Tool ${id} was not consented for this workspace.`,
					);
				}
			}
			emit('tool.started', `Tool ${id} started.`, {
				tool: id,
				ordinal,
				...(invocation.providerCallId
					? { providerCallId: invocation.providerCallId.slice(0, 128) }
					: {}),
			});
			/* The tool runs foreign code: it gets its own signal, a deadline, and
			   any failure becomes an event plus a stable error, never a crash. */
			const toolController = new AbortController();
			const abortTool = () => toolController.abort(controller.signal.reason);
			if (controller.signal.aborted) abortTool();
			else
				controller.signal.addEventListener('abort', abortTool, { once: true });
			let toolTimer: ReturnType<typeof setTimeout> | undefined;
			let rejectToolAbort: (() => void) | undefined;
			try {
				const toolAborted = new Promise<never>((_, reject) => {
					rejectToolAbort = () =>
						reject(
							new AgentHarnessError('TOOL_ABORTED', `Tool ${id} was aborted.`),
						);
					if (toolController.signal.aborted) rejectToolAbort();
					else
						toolController.signal.addEventListener('abort', rejectToolAbort, {
							once: true,
						});
				});
				const output = await Promise.race([
					tool.execute(input, {
						runId: request.runId,
						tenantId: request.tenantId,
						requestedBy: request.requestedBy,
						agentId: request.definition.id,
						agentName: request.definition.name,
						invocation: 'agent-run',
						actor: {
							kind: 'agent',
							id: request.definition.id,
							label: request.definition.name,
							runId: request.runId,
						},
						...(authorizationSubject?.kind === 'user'
							? { authorizationSubject }
							: {}),
						...(idempotencyKey ? { idempotencyKey } : {}),
						permissions,
						signal: toolController.signal,
					}),
					new Promise<never>((_, reject) => {
						/* Reject before aborting: a tool that settles on abort must
						   not win the race against its own deadline. */
						toolTimer = setTimeout(() => {
							reject(
								new AgentHarnessError(
									'TOOL_TIMEOUT',
									`Tool ${id} exceeded ${toolTimeoutMs(tool.timeoutMs)} ms.`,
								),
							);
							toolController.abort('timeout');
						}, toolTimeoutMs(tool.timeoutMs));
					}),
					toolAborted,
				]);
				validateToolOutput(tool.outputSchema, output);
				const bounded = boundToolOutput(output);
				emit('tool.completed', `Tool ${id} completed.`, {
					tool: id,
					outputCharacters: bounded.characters,
					truncated: bounded.truncated,
				});
				return bounded.value;
			} catch (error) {
				const failure = toolFailure(error);
				emit('tool.failed', `Tool ${id} failed.`, {
					tool: id,
					reason: failure.code,
				});
				throw error instanceof AgentHarnessError
					? error
					: new AgentHarnessError(failure.code, failure.message);
			} finally {
				if (toolTimer !== undefined) clearTimeout(toolTimer);
				if (rejectToolAbort)
					toolController.signal.removeEventListener('abort', rejectToolAbort);
				controller.signal.removeEventListener('abort', abortTool);
			}
		};
		/* Wrapped rather than instrumented inside: the wrapper sees exactly what
		   the provider sees, so a denial before the tool ever runs is a span too.
		   Without a tracer the provider is handed the original function. */
		const tracedInvokeTool: typeof invokeTool = !tracer
			? invokeTool
			: async (id, input, invocation = {}) => {
					const span = startSpan(tracer, `tool ${id}`, {
						...(providerSpan ? { parent: providerSpan.context } : {}),
						kind: 'internal',
						attributes: {
							'flowdular.tool': id,
							...(invocation.providerCallId
								? {
										'flowdular.tool.provider_call_id':
											invocation.providerCallId.slice(0, 128),
									}
								: {}),
						},
					});
					try {
						const output = await invokeTool(id, input, invocation);
						endSpan(span, 'ok');
						return output;
					} catch (error) {
						endSpan(
							span,
							'error',
							error instanceof AgentHarnessError ? error.code : 'TOOL_FAILED',
						);
						throw error;
					}
				};
		let timer: ReturnType<typeof setTimeout> | undefined;
		let rejectProviderAbort: (() => void) | undefined;
		try {
			const providerAborted = new Promise<never>((_, reject) => {
				rejectProviderAbort = () =>
					reject(
						new AgentHarnessError(
							'EXECUTION_ABORTED',
							String(controller.signal.reason ?? 'aborted'),
						),
					);
				if (controller.signal.aborted) rejectProviderAbort();
				else
					controller.signal.addEventListener('abort', rejectProviderAbort, {
						once: true,
					});
			});
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					reject(
						new AgentHarnessError(
							'EXECUTION_TIMEOUT',
							`Agent execution exceeded ${request.definition.timeoutMs} ms.`,
						),
					);
					controller.abort('timeout');
				}, request.definition.timeoutMs);
			});
			if (this.#nativeTools.size > 0) {
				await Promise.race([offerNativeTools(), timeout, providerAborted]);
			}
			providerSpan = startSpan(tracer, `provider ${provider.id}`, {
				kind: 'client',
				attributes: {
					'flowdular.agent.run_id': request.runId,
					'flowdular.agent.id': request.definition.id,
					'flowdular.agent.provider': provider.id,
					'flowdular.agent.model': request.definition.model,
					'flowdular.agent.trigger': request.trigger,
				},
			});
			const providerResult = await Promise.race([
				provider.execute({
					request,
					signal: controller.signal,
					availableTools: availableTools.map((tool) => ({
						id: tool.id,
						transport: tool.transport,
						target: tool.target,
						description: tool.description,
						inputSchema: tool.inputSchema ?? {
							type: 'object',
							additionalProperties: false,
						},
					})),
					nativeTools: [...offeredNative.entries()].map(([id, offered]) => ({
						id,
						kind: offered.tool.kind,
						config: offered.config,
					})),
					invokeTool: tracedInvokeTool,
					reportNative,
					emit,
				}),
				timeout,
				providerAborted,
			]);
			if (outputContract.kind === 'json-schema') {
				if (providerResult.structuredOutput === undefined) {
					throw new AgentHarnessError(
						'STRUCTURED_OUTPUT_MISSING',
						'The provider did not return the required structured output.',
					);
				}
				validateStructuredOutput(
					outputContract.schema,
					providerResult.structuredOutput,
				);
			}
			const output = boundedText(
				providerResult.output,
				'provider output',
				1,
				100_000,
			);
			emit('provider.completed', `Provider ${provider.id} completed.`, {
				finishReason: providerResult.finishReason,
			});
			endSpan(providerSpan, 'ok', providerResult.finishReason);
			const completedAt = Date.now();
			emit('run.completed', 'Harness completed the run.');
			return {
				...providerResult,
				output,
				events,
				startedAt,
				completedAt,
			};
		} catch (error) {
			endSpan(
				providerSpan,
				'error',
				error instanceof AgentHarnessError ? error.code : 'PROVIDER_FAILED',
			);
			throw error;
		} finally {
			acceptingEvents = false;
			if (timer !== undefined) clearTimeout(timer);
			if (rejectProviderAbort)
				controller.signal.removeEventListener('abort', rejectProviderAbort);
			options.signal?.removeEventListener('abort', abortFromCaller);
		}
	}
}

const MAX_NATIVE_FIXTURES_BYTES = 1_048_576;

/* The recorded answer of a native web search: the entries the fixtures file
   holds under the run input, exactly as written. A query it does not name
   answers no results rather than a guess. */
async function simulatedWebSearch(
	path: string,
	query: string,
): Promise<readonly AgentNativeResult[]> {
	let fixtures: unknown;
	try {
		if ((await stat(path)).size > MAX_NATIVE_FIXTURES_BYTES) {
			throw new Error('too large');
		}
		fixtures = JSON.parse(await readFile(path, 'utf8'));
	} catch {
		throw new AgentHarnessError(
			'NATIVE_FIXTURES_UNAVAILABLE',
			'The native tool fixtures could not be read.',
		);
	}
	const queries = (fixtures as { queries?: unknown } | null)?.queries;
	if (!queries || typeof queries !== 'object' || Array.isArray(queries)) {
		return [];
	}
	const answer = Object.hasOwn(queries, query)
		? (queries as Record<string, unknown>)[query]
		: undefined;
	return Array.isArray(answer) ? (answer as AgentNativeResult[]) : [];
}

export class LocalSimulationProvider implements AgentProvider {
	readonly id = 'local-simulation';

	async execute(context: AgentProviderContext): Promise<AgentProviderResult> {
		await Promise.resolve();
		if (context.signal.aborted) {
			throw new AgentHarnessError(
				'EXECUTION_ABORTED',
				'The simulation was aborted.',
			);
		}
		const input = context.request.input.trim();
		const native: string[] = [];
		for (const tool of context.nativeTools ?? []) {
			const path = context.request.nativeFixturesPath;
			if (tool.kind !== 'web-search' || path === undefined) {
				await context.reportNative({
					id: tool.id,
					code: NATIVE_TOOL_UNSUPPORTED,
				});
				continue;
			}
			const results = await simulatedWebSearch(path, input);
			await context.reportNative({ id: tool.id, query: input, results });
			native.push(`Native tool ${tool.id}: ${results.length} results.`);
		}
		const output = [
			'Local simulation completed.',
			`Agent: ${context.request.definition.name}`,
			`Trigger: ${context.request.trigger}`,
			`Input: ${input}`,
			...native,
			'No external model or network was called.',
		].join('\n');
		for (const chunk of output.match(/.{1,160}/gs) ?? []) {
			context.emit('provider.output.delta', chunk);
		}
		return {
			output,
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
			},
			finishReason: 'stop',
		};
	}
}
