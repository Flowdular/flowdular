import type { SafeSandboxConfiguration } from '../server/config.ts';
import type { DeliveryRecord } from '../server/delivery/record.ts';
import type { EjectTarget, GitDeliveryPlan } from '../server/delivery/types.ts';
import type { FileDiff } from '../server/diff.ts';
import type { GateResult } from '../server/gates.ts';
import type { SandboxConnection } from '../server/runtime.ts';
import type {
	ChatEntry,
	HandoffPlan,
	SandboxSession,
} from '../server/sessions.ts';

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
	readonly configuration: SafeSandboxConfiguration;
	readonly connection: SandboxConnection;
	readonly drivers: readonly DriverSummary[];
	readonly roles: readonly RoleSummary[];
	readonly sessions: readonly SandboxSession[];
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
	'x-coreloom-sandbox': '1',
} as const;

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? 'The sandbox request failed.');
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
		throw new Error(
			'The sandbox server is not reachable. Start it again with npx @coreloom/sandbox.',
		);
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
		throw new Error(
			'The sandbox server is not reachable. Start it again with npx @coreloom/sandbox.',
		);
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
			running: [],
			signInRequired: true,
		};
	}
	if (!response.ok) {
		throw new Error(value.error?.message ?? 'The sandbox request failed.');
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

export interface ConfigurationPatch {
	readonly disconnect?: boolean;
	readonly platformUrl?: string;
	readonly platformToken?: string;
	readonly driver?: string;
	readonly driverModel?: string | null;
	readonly previewData?: 'fixtures' | 'bridge';
	readonly byokKind?: string;
	readonly byokModel?: string;
	readonly byokCredential?: string;
	readonly byokBaseUrl?: string;
	readonly byokResourceName?: string;
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

export function setAutoContinue(
	id: string,
	enabled: boolean,
): Promise<{ readonly session: SandboxSession }> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/settings`, {
		autoContinue: enabled,
	});
}

export function approveSpecification(
	id: string,
): Promise<{ readonly session: SandboxSession; readonly status: string }> {
	return post(`/sandbox/api/sessions/${encodeURIComponent(id)}/approve`, {});
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
	readonly status: 'running' | 'passed' | 'failed' | 'note';
	readonly detail: string;
}

export interface EjectSummary {
	readonly target: EjectTargetId;
	readonly moduleId: string;
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

const STEP_LABELS: Readonly<Record<string, string>> = {
	fetch: 'Fetch the base branch',
	worktree: 'Prepare a clean worktree',
	branch: 'Create the session branch',
	copy: 'Copy the module into the workspace',
	remove: 'Remove the files the session deleted',
	install: 'Link the module dependencies',
	enable: 'Enable the module in the platform',
	scopes: 'Grant the module scopes to workspace owners',
	verify: 'Typecheck the platform with the module in it',
	guardrails: 'Check the change against the allowed paths and budget',
	commit: 'Commit the change',
	push: 'Push the branch',
	pr: 'Open the pull request',
	cleanup: 'Remove the worktree',
	build: 'Build the platform',
};

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
				handlers.onFailed(value.error?.message ?? 'The eject could not start.');
				return;
			}
			await readEvents(response, (event, payload) => {
				if (event === 'gate.started') {
					handlers.onStep({
						id: `gate:${String(payload.id)}`,
						label: `Gate ${String(payload.id)}`,
						status: 'running',
						detail: '',
					});
					return;
				}
				if (event === 'gate.completed') {
					const gate = payload as unknown as GateResult;
					handlers.onStep({
						id: `gate:${gate.id}`,
						label: gate.module
							? `Gate ${gate.id} (${gate.module})`
							: `Gate ${gate.id}`,
						status: gate.status === 'failed' ? 'failed' : 'passed',
						detail:
							gate.status === 'failed'
								? gate.output.slice(0, 300)
								: gate.status,
					});
					return;
				}
				const [step, phase] = event.split('.');
				if (step && phase && STEP_LABELS[step]) {
					const ok = payload.ok !== false;
					handlers.onStep({
						id: step,
						label: STEP_LABELS[step]!,
						status: phase === 'started' ? 'running' : ok ? 'passed' : 'failed',
						detail:
							phase === 'started'
								? ''
								: typeof payload.files === 'number'
									? `${String(payload.files)} files`
									: ok
										? String(payload.detail ?? '')
										: String(payload.output ?? '').slice(-400),
					});
					return;
				}
				if (event === 'restart.required') {
					handlers.onStep({
						id: 'restart',
						label: 'Restart the application to load the composition',
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
						`${String(payload.message ?? 'The eject failed.')}${
							output ? `\n\n${output.slice(-1_500)}` : ''
						}`,
					);
				}
			});
		} catch (error) {
			handlers.onFailed(
				error instanceof Error ? error.message : 'The eject failed.',
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
				(payload as { message?: string }).message ?? 'The turn failed.',
			);
		}
	});
	handlers.onEnded();
}

/* The turn runs on the server whatever this stream does. Aborting the
   controller only closes this browser's view of it; stopTurn stops the agent. */
export function streamTurn(
	sessionId: string,
	input: {
		readonly message: string;
		readonly role: string;
		readonly driver: string;
	},
	handlers: TurnHandlers,
): AbortController {
	const controller = new AbortController();
	void (async () => {
		try {
			const response = await fetch(
				`/sandbox/api/sessions/${encodeURIComponent(sessionId)}/turn`,
				{
					method: 'POST',
					headers: MUTATION_HEADERS,
					credentials: 'same-origin',
					body: JSON.stringify(input),
					signal: controller.signal,
				},
			);
			if (!response.ok || !response.body) {
				const value = (await response
					.json()
					.catch(() => ({}))) as ErrorEnvelope;
				handlers.onFailed(value.error?.message ?? 'The turn could not start.');
				return;
			}
			await consumeTurnStream(response, handlers);
		} catch (error) {
			if (controller.signal.aborted) return;
			handlers.onFailed(
				error instanceof Error ? error.message : 'The turn failed.',
			);
		}
	})();
	return controller;
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
			void consumeTurnStream(response, handlers).catch(() => {
				if (!controller.signal.aborted) handlers.onEnded();
			});
			return true;
		} catch {
			return false;
		}
	})();
	return { controller, attached };
}
