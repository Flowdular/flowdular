import { t } from '@flowdular/client/i18n';
import { DELIVERY_STEPS, gateLabel } from './session-labels.ts';
import type { SafeSandboxConfiguration } from '../server/config.ts';
import type { DeliveryRecord } from '../server/delivery/record.ts';
import type { SandboxDashboard } from '../server/dashboard.ts';
import type { EjectTarget, GitDeliveryPlan } from '../server/delivery/types.ts';
import type { FileDiff } from '../server/diff.ts';
import type { GateResult } from '../server/gates.ts';
import type { SandboxConnection } from '../server/runtime.ts';
import type {
	ChatEntry,
	HandoffPlan,
	SandboxSession,
	SessionAttachment,
} from '../server/sessions.ts';
import type { ModuleSpecReview } from '../server/spec.ts';

export type { ModuleSpecReview, SessionAttachment };

export interface WorkspaceModuleSummary {
	readonly id: string;
	readonly directory: string;
	readonly name: string;
}

export interface RoleSummary {
	readonly id: string;
	readonly name: string;
	readonly purpose: string;
	readonly allowedPaths: readonly string[];
	readonly gates: readonly string[];
	readonly handoff: readonly string[];
}

export interface DriverSummary {
	readonly id: string;
	readonly label: string;
	readonly kind: 'local-cli' | 'byok';
	readonly requiresLoopback: boolean;
	readonly description: string;
	readonly offered: boolean;
	readonly blockedReason: string | null;
	readonly availability: {
		readonly available: boolean;
		readonly detail: string;
		readonly version: string | null;
	};
}

export interface SandboxState {
	readonly dashboard?: SandboxDashboard;
	readonly configuration: SafeSandboxConfiguration;
	readonly connection: SandboxConnection;
	readonly drivers: readonly DriverSummary[];
	readonly roles: readonly RoleSummary[];
	readonly sessions: readonly SandboxSession[];
	/* Every module of this workspace, so a session can add one to itself. */
	readonly workspaceModules: readonly WorkspaceModuleSummary[];
	/* Ids of the sessions with a turn in flight right now. */
	readonly running: readonly string[];
	/* A self-hosted sandbox that has not seen this browser yet. */
	readonly signInRequired: boolean;
}

export interface SessionView {
	readonly session: SandboxSession;
	readonly paths: {
		readonly module: string;
		readonly modules: readonly { readonly id: string; readonly path: string }[];
	};
	readonly chat: readonly ChatEntry[];
	readonly diffs: readonly (FileDiff & { readonly module: string })[];
	/* One specification review per module, in session order. */
	readonly specs: readonly ModuleSpecReview[];
	/* True while the sandbox still has a turn in flight for this session, even
	   when this browser is not the one that started it. */
	readonly running: boolean;
}

interface ErrorEnvelope {
	readonly error?: { readonly code?: string; readonly message?: string };
}

/* Every mutation carries this header; the server refuses one without it, so
   a cross-site form post can never drive the sandbox. */
const MUTATION_HEADERS = {
	'content-type': 'application/json',
	'x-flowdular-sandbox': '1',
} as const;

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? t('sandbox.api.error.request'));
	}
	return value;
}

/* A dead port must not read as a broken session. Every call says whether the
   sandbox itself is gone or the request was refused. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, { credentials: 'same-origin', ...init });
	} catch {
		throw new Error(t('sandbox.api.error.unreachable'));
	}
	return payload<T>(response);
}

function post<T>(path: string, body: unknown): Promise<T> {
	return request<T>(path, {
		method: 'POST',
		headers: MUTATION_HEADERS,
		body: JSON.stringify(body),
	});
}

export function rejectSandboxSession(id: string): Promise<unknown> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/reject`, {});
}

/* A self-hosted sandbox answers 401 with the little it may say before sign-in;
   the screen then asks for a token instead of showing an error. */
export async function loadSandboxState(): Promise<SandboxState> {
	let response: Response;
	try {
		response = await fetch('/sandbox/api/state', {
			credentials: 'same-origin',
			headers: { accept: 'application/json' },
		});
	} catch {
		throw new Error(t('sandbox.api.error.unreachable'));
	}
	const value = (await response.json()) as Partial<SandboxState> &
		ErrorEnvelope & {
			readonly configuration?: Partial<SafeSandboxConfiguration>;
		};
	if (response.status === 401 && value.configuration) {
		return {
			configuration: {
				mode: value.configuration.mode ?? 'self-hosted',
				platformUrl: value.configuration.platformUrl ?? '',
				platformTokenFingerprint: null,
				driver: '',
				driverModel: null,
				previewData: 'fixtures',
				byok: null,
				github: {
					enabled: true,
					overridesProject: false,
					remote: 'origin',
					repository: null,
					baseBranch: 'main',
					branchPrefix: 'sandbox',
					mode: 'auto',
					forkOwner: null,
					reviewers: [],
					tokenFingerprint: null,
				},
			},
			connection: {
				connected: false,
				authority: null,
				error: {
					code: value.error?.code ?? 'SANDBOX_SIGN_IN_REQUIRED',
					message: value.error?.message ?? 'Sign in to this sandbox.',
				},
			},
			drivers: [],
			roles: [],
			sessions: [],
			workspaceModules: [],
			running: [],
			signInRequired: true,
		};
	}
	if (!response.ok) {
		throw new Error(value.error?.message ?? t('sandbox.api.error.request'));
	}
	return { ...(value as SandboxState), signInRequired: false };
}

export function loadSession(id: string): Promise<SessionView> {
	return request<SessionView>(
		`/sandbox/api/sessions/${encodeURIComponent(id)}`,
		{
			headers: { accept: 'application/json' },
		},
	);
}

/* The GET endpoint that serves an attachment's bytes, used as an <img> source
   for the composer thumbnail. */
export function attachmentUrl(sessionId: string, id: string): string {
	return `/sandbox/api/sessions/${encodeURIComponent(
		sessionId,
	)}/attachments/${encodeURIComponent(id)}`;
}

function fileToBase64(file: Blob): Promise<string> {
	return new Promise((resolveBase64, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = typeof reader.result === 'string' ? reader.result : '';
			const comma = result.indexOf(',');
			resolveBase64(comma >= 0 ? result.slice(comma + 1) : result);
		};
		reader.onerror = () =>
			reject(reader.error ?? new Error('The file could not be read.'));
		reader.readAsDataURL(file);
	});
}

export async function uploadAttachment(
	sessionId: string,
	file: File,
): Promise<{ readonly attachment: SessionAttachment }> {
	const contentBase64 = await fileToBase64(file);
	return post(
		`/sandbox/api/sessions/${encodeURIComponent(sessionId)}/attachments`,
		{ name: file.name, contentBase64 },
	);
}

export function deleteAttachment(
	sessionId: string,
	id: string,
): Promise<{ readonly deleted: boolean }> {
	return post(
		`/sandbox/api/sessions/${encodeURIComponent(
			sessionId,
		)}/attachments/${encodeURIComponent(id)}/delete`,
		{},
	);
}

export interface ConfigurationPatch {
	readonly disconnect?: boolean;
	readonly platformUrl?: string;
	readonly platformToken?: string;
	readonly driver?: string;
	readonly driverModel?: string | null;
	readonly previewData?: 'fixtures' | 'bridge';
	readonly byokRemove?: boolean;
	readonly byokClearCredential?: boolean;
	readonly byokKind?: string;
	readonly byokModel?: string;
	readonly byokCredential?: string;
	readonly byokBaseUrl?: string;
	readonly byokResourceName?: string;
	readonly githubEnabled?: boolean;
	readonly githubOverridesProject?: boolean;
	readonly githubRemote?: string;
	readonly githubRepository?: string;
	readonly githubBaseBranch?: string;
	readonly githubBranchPrefix?: string;
	readonly githubMode?: 'auto' | 'direct' | 'fork';
	readonly githubForkOwner?: string;
	readonly githubReviewers?: readonly string[];
	readonly githubToken?: string;
	readonly githubClearToken?: boolean;
}

export function saveConfiguration(patch: ConfigurationPatch): Promise<{
	readonly configuration: SafeSandboxConfiguration;
	readonly connection: SandboxConnection;
}> {
	return post('/sandbox/api/config', patch);
}

/* Self-hosted sign-in: the token opens a browser session cookie. */
export function connectBrowser(input: {
	readonly token: string;
	readonly platformUrl?: string;
}): Promise<{ readonly authority: unknown }> {
	return post('/sandbox/api/connect', input);
}

export interface WorkPlanView {
	readonly kind: 'new-module' | 'edit-module';
	readonly moduleId: string;
	readonly modules: readonly {
		readonly id: string;
		readonly directory: string;
		readonly kind: 'new' | 'edit';
	}[];
	readonly title: string;
	readonly firstRole: string;
	readonly rationale: string;
	readonly classifiedBy: 'agent' | 'rules';
}

export function createSandboxSession(
	brief: string,
	driver?: string,
): Promise<{
	readonly session: SandboxSession;
	readonly plan: WorkPlanView;
}> {
	return post('/sandbox/api/sessions', {
		brief,
		...(driver ? { driver } : {}),
	});
}

/* Materializes another workspace module into a running session and returns the
   refreshed session view. */
export function addSessionModule(
	id: string,
	moduleId: string,
): Promise<SessionView> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/modules`, {
		moduleId,
	});
}

export function setAutoContinue(
	id: string,
	enabled: boolean,
): Promise<{ readonly session: SandboxSession }> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/settings`, {
		autoContinue: enabled,
	});
}

/* The three answers to a specification review, one module at a time. */
export function approveSpecification(
	id: string,
	module?: string,
): Promise<{
	readonly session: SandboxSession;
	readonly status: string;
	readonly module: string;
}> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/approve`, {
		...(module ? { module } : {}),
	});
}

export function requestSpecChanges(
	id: string,
	module: string,
	comment: string,
): Promise<{
	readonly session: SandboxSession;
	readonly handoff: HandoffPlan;
}> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/spec/changes`, {
		...(module ? { module } : {}),
		comment,
	});
}

export function loadModuleSpec(
	id: string,
	module: string,
): Promise<{
	readonly module: string;
	readonly moduleId: string;
	readonly path: string;
	readonly text: string;
}> {
	return request(
		`/sandbox/api/sessions/${encodeURIComponent(id)}/spec?module=${encodeURIComponent(module)}`,
		{ headers: { accept: 'application/json' } },
	);
}

export function saveModuleSpec(
	id: string,
	module: string,
	text: string,
): Promise<SessionView> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/spec`, {
		...(module ? { module } : {}),
		text,
	});
}

export function archiveSandboxSession(
	id: string,
): Promise<{ readonly session: SandboxSession }> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/archive`, {});
}

export function restoreSandboxSession(
	id: string,
): Promise<{ readonly session: SandboxSession }> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/restore`, {});
}

/* Rolls the session workspace back to an earlier checkpoint. Returns the
   refreshed session view, so the caller can reload the transcript and preview. */
export function restoreCheckpoint(
	id: string,
	sequence: number,
): Promise<SessionView> {
	return post(
		`/sandbox/api/sessions/${encodeURIComponent(id)}/checkpoints/restore`,
		{ sequence },
	);
}

export function deleteSandboxSession(
	id: string,
	options: { readonly keepTranscript?: boolean; readonly stop?: boolean } = {},
): Promise<{ readonly deleted: boolean; readonly keptTranscript: boolean }> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/delete`, {
		keepTranscript: options.keepTranscript !== false,
		stop: options.stop === true,
	});
}

export function stopTurn(id: string): Promise<unknown> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/stop`, {});
}

export function formatSession(id: string): Promise<{
	readonly gate: GateResult;
	readonly gates: readonly GateResult[];
}> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/format`, {});
}

export function runGates(
	id: string,
	gates?: readonly string[],
): Promise<{ readonly gates: readonly GateResult[] }> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/gates`, {
		...(gates ? { gates } : {}),
	});
}

export type EjectTargetId = EjectTarget;

export interface EjectTargetAvailability {
	readonly id: EjectTargetId;
	readonly available: boolean;
	readonly reason: string | null;
}

export interface EjectModulePlanView {
	readonly id: string;
	readonly directory: string;
	readonly kind: 'new' | 'edit';
	readonly targetPath: string;
	readonly files: readonly string[];
	readonly additions: readonly string[];
	readonly overwrites: readonly string[];
	readonly removes: readonly string[];
	readonly newPackages: readonly string[];
	readonly enable: boolean;
}

export interface EjectPlanView {
	readonly target: EjectTargetId;
	readonly moduleId: string;
	readonly targetPath: string;
	readonly files: readonly string[];
	readonly overwrites: readonly string[];
	readonly removes: readonly string[];
	readonly gates: readonly string[];
	readonly newPackages: readonly string[];
	readonly enable: boolean;
	readonly modules: readonly EjectModulePlanView[];
	readonly changedFiles: number;
	readonly platformLocal: boolean;
	readonly restartRequired: boolean;
	readonly notes: readonly string[];
	readonly availableTargets: readonly EjectTargetAvailability[];
	/* Present when the plan targets a pull request. */
	readonly git?: GitDeliveryPlan;
	/* What an earlier delivery of this session left behind, if any. */
	readonly previous?: DeliveryRecord | null;
}

export interface EjectStep {
	readonly id: string;
	readonly label: string;
	readonly gateId?: string;
	readonly module?: string;
	readonly files?: number;
	readonly status: 'running' | 'passed' | 'failed' | 'note';
	readonly detail: string;
}

export interface EjectSummary {
	readonly target: EjectTargetId;
	readonly moduleId: string;
	/* Every module the delivery applied, primary first. */
	readonly modules: readonly string[];
	readonly targetPath: string;
	readonly files: number;
	readonly removed: number;
	readonly enabled: boolean;
	readonly ejectedAt: number;
	readonly restartRequired: boolean;
	readonly platformLocal: boolean;
	readonly branch: string | null;
	readonly pullRequestUrl: string | null;
	readonly compareUrl: string | null;
}

export function planEject(
	id: string,
	target?: EjectTargetId,
): Promise<{
	readonly plan: EjectPlanView;
	readonly target: EjectTargetId;
	readonly availableTargets: readonly EjectTargetAvailability[];
}> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/eject`, {
		apply: false,
		...(target ? { target } : {}),
	});
}

export interface EjectHandlers {
	readonly onStep: (step: EjectStep) => void;
	readonly onDone: (summary: EjectSummary) => void;
	readonly onFailed: (message: string) => void;
}

/* Reads server-sent events from a response body and hands each one to the
   caller. Returns when the stream closes. */
async function readEvents(
	response: Response,
	onEvent: (event: string, payload: Record<string, unknown>) => void,
): Promise<void> {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const blocks = buffer.split('\n\n');
		buffer = blocks.pop() ?? '';
		for (const block of blocks) {
			const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'entry';
			const data = /^data: (.+)$/m.exec(block)?.[1];
			if (!data) continue;
			onEvent(event, JSON.parse(data) as Record<string, unknown>);
		}
	}
}

/* The delivery is watched step by step, so the screen can show what is running
   instead of a spinner with no meaning. */
export function streamEject(
	id: string,
	handlers: EjectHandlers,
	options: {
		readonly build?: boolean;
		readonly target?: EjectTargetId | undefined;
	} = {},
): void {
	void (async () => {
		try {
			const response = await fetch(
				`/sandbox/api/sessions/${encodeURIComponent(id)}/eject`,
				{
					method: 'POST',
					headers: MUTATION_HEADERS,
					credentials: 'same-origin',
					body: JSON.stringify({
						apply: true,
						build: options.build === true,
						...(options.target ? { target: options.target } : {}),
					}),
				},
			);
			if (!response.ok || !response.body) {
				const value = (await response
					.json()
					.catch(() => ({}))) as ErrorEnvelope;
				handlers.onFailed(
					value.error?.message ?? t('sandbox.api.error.deliveryStart'),
				);
				return;
			}
			await readEvents(response, (event, payload) => {
				if (event === 'gate.started') {
					handlers.onStep({
						id: `gate:${String(payload.id)}`,
						label: gateLabel(String(payload.id)),
						gateId: String(payload.id),
						...(typeof payload.module === 'string'
							? { module: payload.module }
							: {}),
						status: 'running',
						detail: '',
					});
					return;
				}
				if (event === 'gate.completed') {
					const gate = payload as unknown as GateResult;
					handlers.onStep({
						id: `gate:${gate.id}`,
						label: gateLabel(gate.id),
						gateId: gate.id,
						...(gate.module ? { module: gate.module } : {}),
						status: gate.status === 'skipped' ? 'note' : gate.status,
						detail:
							gate.status === 'failed'
								? gate.output.slice(0, 300)
								: gate.status,
					});
					return;
				}
				const [step, phase] = event.split('.');
				if (
					step &&
					(phase === 'started' || phase === 'completed') &&
					DELIVERY_STEPS.some((id) => id === step)
				) {
					const ok = payload.ok !== false;
					handlers.onStep({
						id: step,
						...(typeof payload.files === 'number'
							? { files: payload.files }
							: {}),
						label: t('sandbox.delivery.step.' + step),
						status: phase === 'started' ? 'running' : ok ? 'passed' : 'failed',
						detail:
							phase === 'started'
								? ''
								: typeof payload.files === 'number'
									? t('sandbox.eject.detail.files', { count: payload.files })
									: ok
										? String(payload.detail ?? '')
										: String(payload.output ?? '').slice(-400),
					});
					return;
				}
				if (event === 'restart.required') {
					handlers.onStep({
						id: 'restart',
						label: t('sandbox.delivery.step.restart'),
						status: 'note',
						detail: String(payload.note ?? ''),
					});
					return;
				}
				if (event === 'done') {
					handlers.onDone(payload as unknown as EjectSummary);
					return;
				}
				if (event === 'failed') {
					const output =
						typeof payload.output === 'string' ? payload.output : '';
					handlers.onFailed(
						`${String(payload.message ?? t('sandbox.api.error.delivery'))}${
							output ? `\n\n${output.slice(-1_500)}` : ''
						}`,
					);
				}
			});
		} catch (error) {
			handlers.onFailed(
				error instanceof Error
					? error.message
					: t('sandbox.api.error.delivery'),
			);
		}
	})();
}

export interface TurnOutcomeView {
	readonly session: SandboxSession;
	readonly gates: readonly GateResult[];
	readonly handoff: HandoffPlan;
}

export interface TurnHandlers {
	readonly onEntry: (entry: ChatEntry) => void;
	/* One turn of the chain finished; more may follow on the same stream. */
	readonly onCompleted: (outcome: TurnOutcomeView) => void;
	/* The chain is over and nothing runs for this session any more. */
	readonly onEnded: () => void;
	readonly onFailed: (message: string) => void;
}

async function consumeTurnStream(
	response: Response,
	handlers: TurnHandlers,
): Promise<void> {
	await readEvents(response, (event, payload) => {
		if (event === 'entry') handlers.onEntry(payload as unknown as ChatEntry);
		if (event === 'completed') {
			handlers.onCompleted(payload as unknown as TurnOutcomeView);
		}
		if (event === 'failed') {
			handlers.onFailed(
				(payload as { message?: string }).message ??
					t('sandbox.api.error.turn'),
			);
		}
	});
}

/* Every route that starts a turn answers with the same stream, so they share
   one transport. The turn runs on the server whatever this stream does:
   aborting the controller only closes this browser's view of it, and stopTurn
   stops the agent. */
function postTurnStream(
	path: string,
	input: unknown,
	handlers: TurnHandlers,
): AbortController {
	const controller = new AbortController();
	void (async () => {
		try {
			const response = await fetch(path, {
				method: 'POST',
				headers: MUTATION_HEADERS,
				credentials: 'same-origin',
				body: JSON.stringify(input),
				signal: controller.signal,
			});
			if (!response.ok || !response.body) {
				const value = (await response
					.json()
					.catch(() => ({}))) as ErrorEnvelope;
				handlers.onFailed(
					value.error?.message ?? t('sandbox.api.error.turnStart'),
				);
				return;
			}
			await consumeTurnStream(response, handlers);
		} catch (error) {
			if (controller.signal.aborted) return;
			handlers.onFailed(
				error instanceof Error ? error.message : t('sandbox.api.error.turn'),
			);
		} finally {
			if (!controller.signal.aborted) handlers.onEnded();
		}
	})();
	return controller;
}

export function streamTurn(
	sessionId: string,
	input: {
		readonly message: string;
		readonly freshContext?: boolean;
		readonly role: string;
		/* The draft module directory the turn works in; absent lets the sandbox
		   decide from the last handoff. */
		readonly module?: string;
		readonly driver: string;
	},
	handlers: TurnHandlers,
): AbortController {
	return postTurnStream(
		`/sandbox/api/sessions/${encodeURIComponent(sessionId)}/turn`,
		input,
		handlers,
	);
}

export interface SubmittedAnswer {
	readonly id: string;
	readonly answer: string;
}

/* The decisions the operator made on the questions the last turn asked. The
   server prepends them to the optional message and starts the next turn in the
   role that asked, so this is a turn stream like any other. */
export function submitAnswers(
	sessionId: string,
	answers: readonly SubmittedAnswer[],
	message: string,
	handlers: TurnHandlers,
): AbortController {
	return postTurnStream(
		`/sandbox/api/sessions/${encodeURIComponent(sessionId)}/answers`,
		{ answers, ...(message ? { message } : {}) },
		handlers,
	);
}

/* Attach to a turn that is already running, after a reload or from another
   tab. Resolves with false when nothing is running. */
export function followTurn(
	sessionId: string,
	handlers: TurnHandlers,
): {
	readonly controller: AbortController;
	readonly attached: Promise<boolean>;
} {
	const controller = new AbortController();
	const attached = (async () => {
		try {
			const response = await fetch(
				`/sandbox/api/sessions/${encodeURIComponent(sessionId)}/turn/stream`,
				{
					credentials: 'same-origin',
					headers: { accept: 'text/event-stream' },
					signal: controller.signal,
				},
			);
			if (!response.ok || !response.body) return false;
			if (
				!(response.headers.get('content-type') ?? '').startsWith(
					'text/event-stream',
				)
			) {
				return false;
			}
			void consumeTurnStream(response, handlers)
				.catch((error: unknown) => {
					if (!controller.signal.aborted)
						handlers.onFailed(
							error instanceof Error
								? error.message
								: t('sandbox.api.error.turn'),
						);
				})
				.finally(() => {
					if (!controller.signal.aborted) handlers.onEnded();
				});
			return true;
		} catch {
			return false;
		}
	})();
	return { controller, attached };
}
