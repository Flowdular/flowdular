import { byokSettings } from './byok-settings.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ServerRoute, type Context } from '@octanejs/app-core';
import {
	MAX_ATTACHMENT_BYTES,
	addAttachment,
	assertAttachmentId,
	readAttachment,
	removeAttachment,
} from './attachments.ts';
import {
	assertGitHubAccount,
	assertGitHubDeliveryMode,
	assertGitHubRepository,
	assertGitName,
	assertPlatformUrl,
	openSecret,
	safeConfiguration,
	sealSecret,
} from './config.ts';
import {
	DeliveryError,
	assertEjectTarget,
	readDeliveryConfiguration,
	readDeliveryRecord,
	resolveDeliveryTarget,
	spawnCommand,
	writeDeliveryRecord,
	type DeliveryContext,
	type EjectTarget,
} from './delivery/index.ts';
import {
	PREVIEW_COOKIE,
	type PreviewComposition,
	type PreviewRuntime,
} from './preview-runtime.ts';
import { formatSession } from './gates.ts';
import {
	SPEC_OWNER_ROLE,
	assertBrief,
	listWorkspaceModules,
	planWork,
} from './planning.ts';
import {
	collectDiffs,
	forgetDiffs,
	runSessionGates,
	runTurn,
	type TurnContext,
	type TurnOutcome,
} from './turns.ts';
import {
	addSessionModule,
	appendChatEntry,
	approveSpecification,
	archiveSession,
	assertSessionId,
	basePathOf,
	createSession,
	deleteSession,
	findSessionModule,
	installSessionDependencies,
	isSessionId,
	listSessions,
	modulePathOf,
	readChat,
	readSession,
	restoreCheckpoint,
	restoreSession,
	sessionPaths,
	updateSession,
	type SandboxSession,
	type SessionModule,
} from './sessions.ts';
import {
	readModuleSpecReview,
	specPathOf,
	type ModuleSpecReview,
} from './spec.ts';
import { formatDecisions, resolveAnswers } from './questions.ts';
import type { BrowserSession, SandboxRuntime } from './runtime.ts';
import { PlatformClient } from './platform-client.ts';
import { SandboxSetupError } from './workspace-root.ts';
import { canReadSession } from './session-owner.ts';
import { buildDashboard } from './dashboard.ts';
import type { SessionOwner, ChatEntry } from './sessions.ts';
import {
	processTurnChannels,
	waitForTurn,
	type TurnChannel,
	type TurnSubscriber as Subscriber,
} from './turn-lifecycle.ts';

const SANDBOX_COOKIE = 'coreloom_sandbox';
/* Every sandbox mutation carries this header. A cross-site form post cannot
   set it, so together with the origin check it is the CSRF boundary. */
export const SANDBOX_REQUEST_HEADER = 'x-flowdular-sandbox';
const TURN_TIMEOUT_MS = 20 * 60 * 1000;
/* How many handed-off turns may run without the operator saying anything. The
   chain always stops on a failure, on a question, and on this count. */
const CHAIN_LIMIT = 4;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
/* Paths the preview bridge never forwards: the platform's own authentication
   and the sandbox's own records are not preview data. */
const BRIDGE_DENIED = [/^\/api\/auth(\/|$)/, /^\/api\/sandbox(\/|$)/];

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
	SANDBOX_SIGN_IN_REQUIRED: 401,
	SANDBOX_NOT_CONNECTED: 401,
	PLATFORM_TOKEN_MISSING: 401,
	SANDBOX_HOST_REJECTED: 403,
	SANDBOX_CROSS_SITE: 403,
	SANDBOX_HEADER_REQUIRED: 403,
	CONTENT_TYPE_REQUIRED: 415,
	REQUEST_TOO_LARGE: 413,
	INVALID_JSON: 400,
	EJECT_SCOPE_MISSING: 403,
	SESSION_NOT_FOUND: 404,
	ATTACHMENT_NOT_FOUND: 404,
	INVALID_ATTACHMENT_ID: 400,
	ATTACHMENT_NAME_INVALID: 400,
	ATTACHMENT_EMPTY: 400,
	ATTACHMENT_TYPE_REJECTED: 415,
	ATTACHMENT_TOO_LARGE: 413,
	ATTACHMENT_LIMIT_REACHED: 409,
	SESSION_RUNNING: 409,
	SESSION_ARCHIVED: 409,
	SESSION_DELIVERED: 409,
	MODULE_NOT_FOUND: 404,
	MODULE_NOT_IN_SESSION: 400,
	MODULE_ALREADY_IN_SESSION: 409,
	SPEC_NOT_FOUND: 404,
	SPEC_NOT_APPROVED: 409,
	NO_PENDING_QUESTIONS: 409,
	EJECT_SPEC_MISSING: 409,
	EJECT_SPEC_NOT_APPROVED: 409,
	EJECT_SPEC_VERSION_UNCHANGED: 409,
	EJECT_SPEC_SCENARIOS_UNCHANGED: 409,
	EJECT_MIGRATION_IMMUTABLE: 409,
};

/* The specification is a document the operator reviews, not a file the browser
   uploads: this is what a spec edit may carry. */
const MAX_SPEC_TEXT = 200_000;
const MAX_SPEC_COMMENT = 4_000;
const MAX_JSON_BODY_BYTES = 256_000;
/* What an operator may add beside the decisions. The decision list is bounded
   by the questions protocol, so the two together stay inside a turn message. */
const MAX_ANSWER_NOTE = 8_000;

export interface SandboxRouteOptions {
	/* The port the launcher bound. A loopback request must name it in its Host
	   header, so a page on another local port cannot drive this sandbox. */
	readonly port?: number;
}

function json(
	body: unknown,
	status = 200,
	headers: HeadersInit = {},
): Response {
	return Response.json(body, {
		status,
		headers: { 'cache-control': 'no-store', ...headers },
	});
}

function failure(
	error: unknown,
	extra: Record<string, unknown> = {},
): Response {
	if (error instanceof SandboxSetupError) {
		return json(
			{
				error: {
					code: error.code,
					message: error.message,
					...(error instanceof DeliveryError && error.output
						? { output: error.output }
						: {}),
				},
				...extra,
			},
			STATUS_BY_CODE[error.code] ?? 400,
		);
	}
	const message =
		error instanceof Error ? error.message : 'The sandbox request failed.';
	return json({ error: { code: 'SANDBOX_REQUEST_FAILED', message } }, 500);
}

function readCookie(request: Request, name: string): string | null {
	const header = request.headers.get('cookie');
	if (!header) return null;
	for (const item of header.split(';')) {
		const separator = item.indexOf('=');
		if (separator < 1) continue;
		if (item.slice(0, separator).trim() !== name) continue;
		return decodeURIComponent(item.slice(separator + 1).trim());
	}
	return null;
}

async function body(
	request: Request,
	maximumBytes = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
	if (
		!(request.headers.get('content-type') ?? '')
			.toLowerCase()
			.startsWith('application/json')
	) {
		throw new SandboxSetupError(
			'CONTENT_TYPE_REQUIRED',
			'Expected application/json.',
		);
	}
	const contentLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
		throw new SandboxSetupError(
			'REQUEST_TOO_LARGE',
			`The JSON request body is limited to ${maximumBytes} bytes.`,
		);
	}
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	if (request.body) {
		const reader = request.body.getReader();
		try {
			for (;;) {
				const part = await reader.read();
				if (part.done) break;
				bytes += part.value.byteLength;
				if (bytes > maximumBytes) {
					await reader.cancel().catch(() => undefined);
					throw new SandboxSetupError(
						'REQUEST_TOO_LARGE',
						`The JSON request body is limited to ${maximumBytes} bytes.`,
					);
				}
				chunks.push(part.value);
			}
		} finally {
			reader.releaseLock();
		}
	}
	const raw = Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk)),
		bytes,
	).toString('utf8');
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		throw new SandboxSetupError('INVALID_JSON', 'Expected valid JSON.');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new SandboxSetupError('INVALID_INPUT', 'Expected a JSON object.');
	}
	return value as Record<string, unknown>;
}

function text(
	value: Record<string, unknown>,
	key: string,
	maximum = 200,
): string {
	const found = value[key];
	if (typeof found !== 'string' || !found.trim() || found.length > maximum) {
		throw new SandboxSetupError(
			'INVALID_INPUT',
			`${key} must be a string of at most ${maximum} characters.`,
		);
	}
	return found.trim();
}

function optionalText(
	value: Record<string, unknown>,
	key: string,
	maximum = 200,
): string | null {
	const found = value[key];
	if (found === undefined || found === null || found === '') return null;
	return text(value, key, maximum);
}

function sessionIdParam(context: Context): string {
	return assertSessionId(context.params.id ?? '');
}

function attachmentIdParam(context: Context): string {
	return assertAttachmentId(context.params.attachmentId ?? '');
}

/* Decodes a base64 field into bytes, refusing a payload that could not fit the
   size limit before it is decoded, so an oversized upload never allocates. */
function base64Field(
	value: Record<string, unknown>,
	key: string,
	maxBytes: number,
): Buffer {
	const raw = value[key];
	if (typeof raw !== 'string' || raw.length === 0) {
		throw new SandboxSetupError(
			'INVALID_INPUT',
			`${key} must be a base64 string.`,
		);
	}
	if (raw.length > Math.ceil(maxBytes / 3) * 4 + 4) {
		throw new SandboxSetupError(
			'ATTACHMENT_TOO_LARGE',
			`Attachments are limited to ${maxBytes / (1024 * 1024)} MB.`,
		);
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
		throw new SandboxSetupError('INVALID_INPUT', `${key} is not valid base64.`);
	}
	return Buffer.from(raw, 'base64');
}

/* A loopback sandbox trusts the machine it runs on and nothing else: the
   request must be addressed to the loopback name and port it was started on,
   so a page served from another local port cannot reach it by name. */
function assertLoopbackHost(request: Request, port: number | undefined): void {
	const host = request.headers.get('host') ?? '';
	const separator = host.lastIndexOf(':');
	const bracketed = host.startsWith('[');
	const name =
		bracketed && host.includes(']')
			? host.slice(0, host.indexOf(']') + 1)
			: separator > 0
				? host.slice(0, separator)
				: host;
	const requestPort =
		separator > (bracketed ? host.indexOf(']') : -1)
			? host.slice(separator + 1)
			: '';
	if (
		!LOOPBACK_HOSTS.has(name.toLowerCase()) ||
		(port !== undefined && requestPort !== String(port))
	) {
		throw new SandboxSetupError(
			'SANDBOX_HOST_REJECTED',
			'A loopback sandbox answers only requests addressed to its own loopback address and port.',
		);
	}
}

/* The browser-facing half of the origin boundary: the fetch metadata and the
   Origin header must name this server. A cross-site form post satisfies
   neither. This is the only place that sees the origin the browser used, so
   every request that leaves for an internal hop is checked here first. */
export function assertBrowserOrigin(request: Request): void {
	const site = request.headers.get('sec-fetch-site');
	if (site && site !== 'same-origin' && site !== 'none') {
		throw new SandboxSetupError(
			'SANDBOX_CROSS_SITE',
			'Sandbox mutations are accepted from the sandbox page only.',
		);
	}
	const origin = request.headers.get('origin');
	if (!origin) return;
	let originHost: string;
	try {
		originHost = new URL(origin).host;
	} catch {
		originHost = '';
	}
	if (!originHost || originHost !== (request.headers.get('host') ?? '')) {
		throw new SandboxSetupError(
			'SANDBOX_CROSS_SITE',
			'Sandbox mutations are accepted from the sandbox page only.',
		);
	}
}

/* Mutations must come from the sandbox's own page: the browser origin must
   name this server, and the custom header must be present. */
export function assertSameOrigin(request: Request): void {
	assertBrowserOrigin(request);
	if (request.headers.get(SANDBOX_REQUEST_HEADER) !== '1') {
		throw new SandboxSetupError(
			'SANDBOX_HEADER_REQUIRED',
			`Sandbox mutations carry the ${SANDBOX_REQUEST_HEADER} header.`,
		);
	}
}

function browserSession(
	runtime: SandboxRuntime,
	context: Context,
): BrowserSession | null {
	return runtime.browserSession(readCookie(context.request, SANDBOX_COOKIE));
}

interface AuthorizeOptions {
	/* Configuration and status calls are how a sandbox gets connected, so they
	   cannot demand a connection. */
	readonly allowDisconnected?: boolean;
	readonly mutation?: boolean;
}

/* Loopback binds to the local interface and uses the configured connection.
   A self-hosted sandbox authenticates every browser with its own API token. */
async function authorize(
	runtime: SandboxRuntime,
	context: Context,
	options: SandboxRouteOptions,
	policy: AuthorizeOptions = {},
): Promise<void> {
	if (policy.mutation) assertSameOrigin(context.request);
	if (runtime.configuration().mode === 'loopback') {
		assertLoopbackHost(context.request, options.port);
		if (!policy.allowDisconnected && !runtime.connection().connected) {
			throw new SandboxSetupError(
				runtime.connection().error?.code ?? 'SANDBOX_NOT_CONNECTED',
				runtime.connection().error?.message ??
					'The sandbox is not connected to a Flowdular application yet.',
			);
		}
	} else if (!browserSession(runtime, context)) {
		throw new SandboxSetupError(
			'SANDBOX_SIGN_IN_REQUIRED',
			'Connect this browser with an API token issued by the Flowdular application.',
		);
	}
	const id = context.url.pathname.startsWith('/sandbox/api/sessions/')
		? sessionIdParam(context)
		: context.url.pathname.startsWith('/api/')
			? previewSessionId(context)
			: null;
	if (id) {
		const session = await readSession(runtime.workspaceRoot, id);
		if (
			session.state === 'deleted' ||
			!canReadSession(
				session,
				actingOwner(runtime, context),
				runtime.configuration().mode === 'loopback',
			)
		) {
			throw new SandboxSetupError(
				'SESSION_NOT_FOUND',
				'This session is not available to this account.',
			);
		}
	}
}

function actingOwner(
	runtime: SandboxRuntime,
	context: Context,
): SessionOwner | null {
	const authority =
		runtime.configuration().mode === 'loopback'
			? runtime.connection().authority
			: browserSession(runtime, context)?.authority;
	if (!authority) return null;
	return {
		platformUrl: runtime.configuration().platformUrl.replace(/\/+$/, ''),
		accountId: authority.principal.accountId,
		tenantId: authority.principal.tenantId,
	};
}

function actingPlatform(
	runtime: SandboxRuntime,
	context: Context,
): PlatformClient | null {
	if (runtime.configuration().mode === 'loopback') return runtime.platform();
	const browser = browserSession(runtime, context);
	return browser
		? new PlatformClient({
				platformUrl: runtime.configuration().platformUrl,
				token: browser.token,
			})
		: null;
}

/* The capabilities that count are the acting principal's: the browser session
   in self-hosted mode, the configured connection in loopback mode. */
function actingCapabilities(
	runtime: SandboxRuntime,
	context: Context,
): readonly string[] {
	const authority =
		runtime.configuration().mode === 'loopback'
			? runtime.connection().authority
			: browserSession(runtime, context)?.authority;
	return authority?.authority.granted ? authority.authority.capabilities : [];
}

function sessionCookie(id: string, secure: boolean): string {
	return [
		`${SANDBOX_COOKIE}=${encodeURIComponent(id)}`,
		'Path=/',
		'HttpOnly',
		'SameSite=Strict',
		'Max-Age=43200',
		...(secure ? ['Secure'] : []),
	].join('; ');
}

/* One review per module: the draft specification, the copy the session started
   from, the difference between them, and whether the operator approved it. The
   card renders this and nothing it fetches itself. */
function sessionSpecs(
	workspaceRoot: string,
	session: SandboxSession,
): Promise<readonly ModuleSpecReview[]> {
	const paths = sessionPaths(workspaceRoot, session.id, session.moduleSuffix);
	return Promise.all(
		session.modules.map((module) =>
			readModuleSpecReview(
				module,
				modulePathOf(paths, module.directory),
				basePathOf(paths, module.directory),
			),
		),
	);
}

/* The one place a client-named module turns into a specification path. The
   module is always one the session holds, so nothing a request says reaches the
   file system by itself. */
function specFileOf(
	workspaceRoot: string,
	session: SandboxSession,
	module: SessionModule,
): string {
	return specPathOf(
		modulePathOf(
			sessionPaths(workspaceRoot, session.id, session.moduleSuffix),
			module.directory,
		),
	);
}

async function readSpecFile(
	workspaceRoot: string,
	session: SandboxSession,
	module: SessionModule,
): Promise<string> {
	try {
		return await readFile(specFileOf(workspaceRoot, session, module), 'utf8');
	} catch {
		throw new SandboxSetupError(
			'SPEC_NOT_FOUND',
			`${module.id} has no specification in this session yet.`,
		);
	}
}

async function writeSpecFile(
	workspaceRoot: string,
	session: SandboxSession,
	module: SessionModule,
	text: string,
): Promise<void> {
	const path = specFileOf(workspaceRoot, session, module);
	/* The editor writes a draft. `approved` is reserved for the approval route,
	   which records the matching hash in session.json at the same time. */
	const draftStatus = module.kind === 'new' ? 'draft' : 'in-review';
	const draft = text.replace(
		/^status:[ \t]*approved[ \t]*$/m,
		`status: ${draftStatus}`,
	);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, draft, 'utf8');
}

async function sessionView(
	runtime: SandboxRuntime,
	session: SandboxSession,
	busy = false,
) {
	return {
		session,
		/* Workspace-relative locations only; the host file system layout never
		   reaches the browser. */
		paths: {
			module: `modules/${session.moduleSuffix}`,
			modules: session.modules.map((module) => ({
				id: module.id,
				path: `modules/${module.directory}`,
			})),
		},
		chat: await readChat(runtime.workspaceRoot, session),
		diffs: await collectDiffs(runtime.workspaceRoot, session),
		specs: await sessionSpecs(runtime.workspaceRoot, session),
		/* A turn outlives the request that started it, so a browser that reloads
		   mid-turn has to be told the agent is still working. */
		running: busy,
	};
}

/* The preview session a request belongs to. The preview page sets the cookie
   before it loads the module, and the iframe URL is the fallback so a request
   made before that still reaches the right session. */
function previewSessionId(context: Context): string | null {
	const cookie = readCookie(context.request, PREVIEW_COOKIE);
	if (cookie) return isSessionId(cookie) ? cookie : null;
	const referer = context.request.headers.get('referer');
	if (!referer) return null;
	try {
		const segments = new URL(referer).pathname.split('/').filter(Boolean);
		const id = segments[0] === 'preview' ? (segments[1] ?? '') : '';
		return isSessionId(id) ? id : null;
	} catch {
		return null;
	}
}

function assertNotArchived(session: SandboxSession): void {
	if (session.archivedAt !== null) {
		throw new SandboxSetupError(
			'SESSION_ARCHIVED',
			'This session is archived. Restore it before working on it again.',
		);
	}
}

function assertNotDelivered(session: SandboxSession): void {
	if (session.ejectedAt !== null) {
		throw new SandboxSetupError(
			'SESSION_DELIVERED',
			'This session was already delivered. Start a new session for a further specification change.',
		);
	}
}

/* The turn one accepted answer set starts: the decisions the specialist reads
   back, in the role and the module that asked for them. */
interface AnsweredTurn {
	readonly message: string;
	readonly role: string;
	readonly module?: string;
}

/* A turn, or a chain of automatically continued turns, runs to completion on
   the server whatever happens to the browser. Streams subscribe to it and can
   leave at any time; stopping is an explicit action. The finished promise is
   kept with the controller because a superseding turn must wait for the old
   process to release the driver's thread before it resumes it. */
export function createSandboxRoutes(
	runtime: SandboxRuntime,
	preview: PreviewRuntime,
	options: SandboxRouteOptions = {},
): readonly ServerRoute[] {
	const running = processTurnChannels(runtime.workspaceRoot);
	const secureCookies = runtime.configuration().mode !== 'loopback';

	const turnContext = (platform = runtime.platform()): TurnContext => ({
		workspaceRoot: runtime.workspaceRoot,
		configuration: runtime.configuration(),
		registry: runtime.registry(),
		roles: runtime.roles(),
		platform,
	});

	const publish = (channel: TurnChannel, event: string, payload: unknown) => {
		for (const subscriber of channel.subscribers) {
			/* A subscriber is a client connection; its failure must never stop
			   the turn or reach the other subscribers. */
			try {
				subscriber(event, payload);
			} catch {
				channel.subscribers.delete(subscriber);
			}
		}
	};

	/* Starts a turn detached from any request. Handoffs marked continue keep
	   running on the same channel while the session allows it, so the chain is
	   the server's decision and survives a closed tab. */
	const startTurn = (
		sessionId: string,
		input: {
			message: string;
			skillTask?: string;
			freshContext?: boolean;
			role?: string;
			module?: string;
			driver?: string;
		},
		platform: PlatformClient | null,
	): TurnChannel => {
		const previous = running.get(sessionId);
		const controller = new AbortController();
		let release = () => undefined as void;
		const channel: TurnChannel = {
			controller,
			finished: new Promise<void>((resolveFinished) => {
				release = () => resolveFinished();
			}),
			subscribers: new Set(),
		};
		/* Claimed before anything awaits, so two requests arriving together
		   cannot both believe they are the only turn. */
		running.set(sessionId, channel);
		previous?.controller.abort('superseded');
		const timer = setTimeout(
			() => controller.abort('timeout'),
			TURN_TIMEOUT_MS,
		);
		timer.unref?.();

		void (async () => {
			try {
				if (previous) await waitForTurn(previous);
				await updateSession(runtime.workspaceRoot, sessionId, {
					chainDepth: 0,
				});
				let next: {
					message: string;
					skillTask?: string;
					role?: string;
					module?: string;
					driver?: string;
				} | null = input;
				let depth = 0;
				while (next && !controller.signal.aborted) {
					const iterator = runTurn(turnContext(platform), {
						sessionId,
						...next,
						signal: controller.signal,
					});
					let step = await iterator.next();
					while (!step.done) {
						publish(channel, 'entry', step.value);
						step = await iterator.next();
					}
					const outcome: TurnOutcome = step.value;
					publish(channel, 'completed', outcome);
					next = null;
					if (
						outcome.handoff.kind === 'continue' &&
						outcome.session.autoContinue &&
						depth + 1 < CHAIN_LIMIT &&
						!controller.signal.aborted
					) {
						depth += 1;
						await updateSession(runtime.workspaceRoot, sessionId, {
							chainDepth: depth,
						});
						next = {
							message: outcome.handoff.prompt,
							role: outcome.handoff.role,
							...(outcome.handoff.module
								? { module: outcome.handoff.module }
								: {}),
						};
					}
				}
			} catch (error) {
				publish(channel, 'failed', {
					code: error instanceof SandboxSetupError ? error.code : 'TURN_FAILED',
					message: error instanceof Error ? error.message : 'The turn failed.',
				});
			} finally {
				clearTimeout(timer);
				/* A timed-out or superseded waiter still represents its predecessor.
				   Keep the chain owned until the actual writer has drained. */
				if (previous) await previous.finished;
				if (running.get(sessionId) === channel) running.delete(sessionId);
				publish(channel, 'ended', { sessionId });
				channel.subscribers.clear();
				release();
			}
		})();
		return channel;
	};

	/* One server-sent event stream over a channel. Closing the stream only
	   unsubscribes; the turn keeps running. */
	const streamChannel = (channel: TurnChannel): Response => {
		const encoder = new TextEncoder();
		let subscriber: Subscriber | null = null;
		const stream = new ReadableStream<Uint8Array>({
			start(streamController) {
				let closed = false;
				subscriber = (event, payload) => {
					if (closed) return;
					streamController.enqueue(
						encoder.encode(
							`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
						),
					);
					if (event === 'ended') {
						closed = true;
						streamController.close();
					}
				};
				channel.subscribers.add(subscriber);
			},
			cancel() {
				if (subscriber) channel.subscribers.delete(subscriber);
			},
		});
		return new Response(stream, {
			headers: {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-store',
				connection: 'keep-alive',
			},
		});
	};

	const state = new ServerRoute({
		path: '/sandbox/api/state',
		methods: ['GET'],
		handler: async (context) => {
			const configuration = runtime.configuration();
			try {
				await authorize(runtime, context, options, { allowDisconnected: true });
			} catch (error) {
				/* An unauthenticated self-hosted browser still needs to know it must
				   sign in, and where; nothing else leaves. */
				return failure(error, {
					configuration: {
						mode: configuration.mode,
						platformUrl: configuration.platformUrl,
					},
				});
			}
			/* A platform that was down when the sandbox started must not stay
			   unreachable forever: the state poll retries the connection. */
			if (!runtime.connection().connected) await runtime.refresh();
			const owner = actingOwner(runtime, context);
			const sessions = (await listSessions(runtime.workspaceRoot, true)).filter(
				(session) =>
					canReadSession(session, owner, configuration.mode === 'loopback'),
			);
			const visible = sessions.filter((session) => session.state !== 'deleted');
			return json({
				configuration: safeConfiguration(configuration),
				connection:
					configuration.mode === 'self-hosted'
						? {
								connected: true,
								authority: browserSession(runtime, context)!.authority,
								error: null,
							}
						: runtime.connection(),
				drivers: await runtime.registry().status(),
				roles: runtime.roles().map((role) => ({
					id: role.id,
					name: role.name,
					purpose: role.purpose,
					allowedPaths: role.allowedPaths,
					gates: role.gates,
					handoff: role.handoff,
				})),
				sessions: visible,
				dashboard: await buildDashboard(
					runtime.workspaceRoot,
					sessions,
					owner,
					new Set(running.keys()),
				),
				/* What a session may still add to itself. */
				workspaceModules: await listWorkspaceModules(runtime.workspaceRoot),
				running: visible
					.filter((session) => running.has(session.id))
					.map((session) => session.id),
			});
		},
	});

	/* The mode is the launcher's decision from the interface it bound and is
	   never accepted over HTTP. A new platform address needs a token pasted
	   with it, so the stored token can never be replayed to another host. */
	const configure = new ServerRoute({
		path: '/sandbox/api/config',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, {
					allowDisconnected: true,
					mutation: true,
				});
				const value = await body(context.request);
				const token = optionalText(value, 'platformToken', 4_096);
				const githubToken = optionalText(value, 'githubToken', 16_384);
				const configuration = runtime.configuration();
				if (value.disconnect === true) {
					return json({
						configuration: safeConfiguration(runtime.configuration()),
						connection: await runtime.update({ platformToken: null }),
					});
				}
				const platformUrl =
					value.platformUrl === undefined
						? null
						: assertPlatformUrl(text(value, 'platformUrl', 300));
				if (
					platformUrl !== null &&
					platformUrl !== configuration.platformUrl &&
					!token
				) {
					throw new SandboxSetupError(
						'PLATFORM_TOKEN_REQUIRED',
						'Changing the application address needs the API token for that application.',
					);
				}
				const githubPatchRequested = [
					'githubEnabled',
					'githubOverridesProject',
					'githubRemote',
					'githubRepository',
					'githubBaseBranch',
					'githubBranchPrefix',
					'githubMode',
					'githubForkOwner',
					'githubReviewers',
				].some((key) => value[key] !== undefined);
				if (
					value.githubOverridesProject !== undefined &&
					typeof value.githubOverridesProject !== 'boolean'
				) {
					throw new SandboxSetupError(
						'GITHUB_CONFIG_INVALID',
						'The GitHub project override flag must be a boolean.',
					);
				}
				if (
					value.githubEnabled !== undefined &&
					typeof value.githubEnabled !== 'boolean'
				) {
					throw new SandboxSetupError(
						'GITHUB_CONFIG_INVALID',
						'The GitHub enabled flag must be a boolean.',
					);
				}
				let github = configuration.github;
				if (githubPatchRequested) {
					const reviewersValue = value.githubReviewers;
					if (
						reviewersValue !== undefined &&
						(!Array.isArray(reviewersValue) ||
							reviewersValue.length > 20 ||
							reviewersValue.some((entry) => typeof entry !== 'string'))
					) {
						throw new SandboxSetupError(
							'GITHUB_CONFIG_INVALID',
							'The GitHub reviewers must be a list of account names.',
						);
					}
					github = {
						...github,
						...(typeof value.githubOverridesProject === 'boolean'
							? { overridesProject: value.githubOverridesProject }
							: { overridesProject: true }),
						...(typeof value.githubEnabled === 'boolean'
							? { enabled: value.githubEnabled }
							: {}),
						...(value.githubRemote === undefined
							? {}
							: {
									remote: assertGitName(
										text(value, 'githubRemote', 120),
										'remote',
									),
								}),
						...(value.githubRepository === undefined
							? {}
							: {
									repository: assertGitHubRepository(
										optionalText(value, 'githubRepository', 160),
									),
								}),
						...(value.githubBaseBranch === undefined
							? {}
							: {
									baseBranch: assertGitName(
										text(value, 'githubBaseBranch', 120),
										'baseBranch',
									),
								}),
						...(value.githubBranchPrefix === undefined
							? {}
							: {
									branchPrefix: assertGitName(
										text(value, 'githubBranchPrefix', 120),
										'branchPrefix',
									),
								}),
						...(value.githubMode === undefined
							? {}
							: {
									mode: assertGitHubDeliveryMode(text(value, 'githubMode', 20)),
								}),
						...(value.githubForkOwner === undefined
							? {}
							: {
									forkOwner: assertGitHubAccount(
										optionalText(value, 'githubForkOwner', 80),
									),
								}),
						...(reviewersValue === undefined
							? {}
							: {
									reviewers: (reviewersValue as string[]).map((entry) => {
										if (entry.trim() === '') {
											throw new SandboxSetupError(
												'GITHUB_CONFIG_INVALID',
												'The GitHub reviewers must be account names.',
											);
										}
										const reviewer = assertGitHubAccount(entry.trim());
										return reviewer as string;
									}),
								}),
					};
				}
				const byok = await byokSettings(
					runtime.workspaceRoot,
					value,
					configuration.byok,
				);
				const connection = await runtime.update({
					...(platformUrl === null ? {} : { platformUrl }),
					...(token
						? {
								platformToken: await sealSecret(runtime.workspaceRoot, token),
							}
						: {}),
					...(value.driver === undefined
						? {}
						: { driver: text(value, 'driver', 64) }),
					...(value.driverModel === undefined
						? {}
						: { driverModel: optionalText(value, 'driverModel', 160) }),
					...(value.previewData === 'fixtures' || value.previewData === 'bridge'
						? { previewData: value.previewData }
						: {}),
					...(byok === undefined ? {} : { byok }),
					...(githubPatchRequested ? { github } : {}),
					...(githubToken
						? {
								gitProviderToken: await sealSecret(
									runtime.workspaceRoot,
									githubToken,
								),
							}
						: value.githubClearToken === true
							? { gitProviderToken: null }
							: {}),
				});
				return json({
					configuration: safeConfiguration(runtime.configuration()),
					connection,
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* Sign-in for a self-hosted browser. The application address may be set
	   here only while the sandbox has no token yet, so a fresh deployment can
	   be pointed at its application once and never redirected afterwards. */
	const connect = new ServerRoute({
		path: '/sandbox/api/connect',
		methods: ['POST'],
		handler: async (context) => {
			try {
				assertSameOrigin(context.request);
				if (runtime.configuration().mode === 'loopback') {
					assertLoopbackHost(context.request, options.port);
				}
				const value = await body(context.request);
				const platformUrl = optionalText(value, 'platformUrl', 300);
				if (
					platformUrl &&
					runtime.configuration().platformToken === null &&
					assertPlatformUrl(platformUrl) !== runtime.configuration().platformUrl
				) {
					await runtime.update({ platformUrl: assertPlatformUrl(platformUrl) });
				}
				const session = await runtime.openBrowserSession(
					text(value, 'token', 4_096),
				);
				return json({ authority: session.authority }, 200, {
					'set-cookie': sessionCookie(session.id, secureCookies),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* A session starts from one brief. The planner decides whether this is a new
	   module or a change to existing ones, names them, and picks the specialist
	   who takes the first turn, so nobody has to choose an agent up front. */
	const createSandboxSession = new ServerRoute({
		path: '/sandbox/api/sessions',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const value = await body(context.request);
				const brief = assertBrief(text(value, 'brief', 20_000));
				const configuration = runtime.configuration();
				const driver =
					optionalText(value, 'driver', 64) ?? configuration.driver;
				const owner = actingOwner(runtime, context);
				if (!owner)
					throw new SandboxSetupError(
						'SANDBOX_NOT_CONNECTED',
						'Connect an account before starting work.',
					);
				const planningEvents: Omit<ChatEntry, 'sequence' | 'at'>[] = [];
				const plan = await planWork({
					onEvent: (event) => {
						if (
							event.type === 'turn.started' ||
							event.type === 'turn.completed'
						)
							planningEvents.push({ kind: 'event', role: 'planner', event });
					},
					brief,
					driver,
					registry: runtime.registry(),
					roles: runtime.roles(),
					modules: await listWorkspaceModules(runtime.workspaceRoot),
				});

				const session = await createSession({
					owner,
					workspaceRoot: runtime.workspaceRoot,
					kind: plan.kind,
					moduleId: plan.moduleId,
					modules: plan.modules,
					title: plan.title,
					brief,
					blueprint:
						plan.kind === 'new-module'
							? 'new-module@1.0.0'
							: 'edit-module@1.0.0',
					role: plan.firstRole,
					driver,
					model: configuration.driverModel,
					...(plan.sourceModule ? { sourceModule: plan.sourceModule } : {}),
				});

				/* The classification is the first thing the operator sees, so a
				   wrong guess can be corrected in the first message. */
				await appendChatEntry(runtime.workspaceRoot, session, {
					kind: 'system',
					role: plan.firstRole,
					text: `${plan.kind === 'new-module' ? 'New module' : 'Change to'} ${plan.modules
						.map((module) => `${module.id} (modules/${module.directory})`)
						.join(
							', ',
						)}, classified by the ${plan.classifiedBy === 'agent' ? 'planner' : 'workspace rules'}. ${plan.rationale} Say so in your first message if this is the wrong module.`,
				});

				for (const entry of planningEvents)
					await appendChatEntry(runtime.workspaceRoot, session, entry);
				const platform = actingPlatform(runtime, context);
				if (platform) {
					await platform
						.registerSession({
							sessionId: session.id,
							moduleId: session.moduleId,
							title: session.title,
							blueprint: session.blueprint,
							driver: session.driver,
							mode: configuration.mode,
						})
						.then(async () => {
							await updateSession(runtime.workspaceRoot, session.id, {
								registeredWithPlatform: true,
							});
						})
						.catch(() => undefined);
				}
				return json(
					{
						session: await readSession(runtime.workspaceRoot, session.id),
						plan,
					},
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const readSandboxSession = new ServerRoute({
		path: '/sandbox/api/sessions/:id',
		methods: ['GET'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options);
				const session = await readSession(
					runtime.workspaceRoot,
					sessionIdParam(context),
				);
				return json(
					await sessionView(runtime, session, running.has(session.id)),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* A session grows: an existing module of this workspace is materialized into
	   the session, with its pristine base, and joins the modules the turns,
	   gates, preview and delivery already iterate. The primary module never
	   changes, so nothing that keyed on it moves. */
	const addSandboxModule = new ServerRoute({
		path: '/sandbox/api/sessions/:id/modules',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const sessionId = sessionIdParam(context);
				const value = await body(context.request);
				const moduleId = text(value, 'moduleId', 120);
				const session = await readSession(runtime.workspaceRoot, sessionId);
				assertNotArchived(session);
				if (running.has(sessionId)) {
					throw new SandboxSetupError(
						'SESSION_RUNNING',
						'A turn is still running in this session. Wait for it or stop it before adding a module.',
					);
				}
				if (session.ejectedAt !== null) {
					throw new SandboxSetupError(
						'SESSION_DELIVERED',
						'This session was already delivered. Start a new session to work on another module.',
					);
				}
				const known = (await listWorkspaceModules(runtime.workspaceRoot)).find(
					(module) => module.id === moduleId,
				);
				if (!known) {
					throw new SandboxSetupError(
						'MODULE_NOT_FOUND',
						`No module ${moduleId} exists in this workspace.`,
					);
				}
				const updated = await addSessionModule(runtime.workspaceRoot, session, {
					id: known.id,
					directory: known.directory,
					kind: 'edit',
				});
				const install = await installSessionDependencies(
					runtime.workspaceRoot,
					updated,
				);
				await appendChatEntry(runtime.workspaceRoot, updated, {
					kind: 'system',
					role: updated.role,
					module: known.directory,
					text: `Added ${known.id} (modules/${known.directory}) to this session. Its working copy and its pristine base are in the session workspace.${
						install.ran && !install.ok
							? `\n\nThe session workspace could not install the declared dependencies:\n${install.output}`
							: ''
					}`,
				});
				forgetDiffs(sessionId);
				await preview.forget(sessionId);
				return json(
					await sessionView(
						runtime,
						await readSession(runtime.workspaceRoot, sessionId),
						false,
					),
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* Uploads stay outside the active workspace. Each turn copies its attachment
	   snapshot into reference/attachments/ before the path guard starts. */
	const addSandboxAttachment = new ServerRoute({
		path: '/sandbox/api/sessions/:id/attachments',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const sessionId = sessionIdParam(context);
				const session = await readSession(runtime.workspaceRoot, sessionId);
				assertNotArchived(session);
				const value = await body(
					context.request,
					Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 2_048,
				);
				const attachment = await addAttachment(runtime.workspaceRoot, session, {
					name: text(value, 'name', 256),
					bytes: base64Field(value, 'contentBase64', MAX_ATTACHMENT_BYTES),
				});
				return json({ attachment }, 201);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const removeSandboxAttachment = new ServerRoute({
		path: '/sandbox/api/sessions/:id/attachments/:attachmentId/delete',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const session = await readSession(
					runtime.workspaceRoot,
					sessionIdParam(context),
				);
				await removeAttachment(
					runtime.workspaceRoot,
					session,
					attachmentIdParam(context),
				);
				return json({ deleted: true });
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* Serves the bytes for the composer thumbnail. A read, so it needs no
	   mutation header; the same-origin cookie or loopback host still gates it. */
	const serveSandboxAttachment = new ServerRoute({
		path: '/sandbox/api/sessions/:id/attachments/:attachmentId',
		methods: ['GET'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options);
				const session = await readSession(
					runtime.workspaceRoot,
					sessionIdParam(context),
				);
				const attachment = await readAttachment(
					runtime.workspaceRoot,
					session,
					attachmentIdParam(context),
				);
				return new Response(new Uint8Array(attachment.bytes), {
					headers: {
						'content-type': attachment.contentType,
						'content-disposition': `inline; filename="${attachment.name}"`,
						'cache-control': 'private, no-store',
						'x-content-type-options': 'nosniff',
					},
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* Lifecycle actions refuse a running session unless the caller says stop:
	   a turn that is still writing must not lose its workspace under it. */
	const stopIfRequested = async (
		sessionId: string,
		value: Record<string, unknown>,
	): Promise<void> => {
		const channel = running.get(sessionId);
		if (!channel) return;
		if (value.stop !== true) {
			throw new SandboxSetupError(
				'SESSION_RUNNING',
				'A turn is still running in this session. Stop it first.',
			);
		}
		channel.controller.abort('stopped');
		await waitForTurn(channel);
	};

	const notifyPlatform = async (
		session: SandboxSession,
		state: string,
		context: Context,
	): Promise<void> => {
		if (!session.registeredWithPlatform) return;
		await actingPlatform(runtime, context)
			?.updateSessionState(session.id, state)
			.catch(() => undefined);
	};

	const archiveSandboxSession = new ServerRoute({
		path: '/sandbox/api/sessions/:id/archive',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const sessionId = sessionIdParam(context);
				const value = await body(context.request);
				await readSession(runtime.workspaceRoot, sessionId);
				await stopIfRequested(sessionId, value);
				const session = await archiveSession(runtime.workspaceRoot, sessionId);
				await preview.forget(sessionId);
				await notifyPlatform(session, 'archived', context);
				return json({ session });
			} catch (error) {
				return failure(error);
			}
		},
	});

	const restoreSandboxSession = new ServerRoute({
		path: '/sandbox/api/sessions/:id/restore',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const sessionId = sessionIdParam(context);
				await body(context.request);
				const session = await restoreSession(runtime.workspaceRoot, sessionId);
				await notifyPlatform(session, session.state, context);
				return json({ session });
			} catch (error) {
				return failure(error);
			}
		},
	});

	const rejectSandboxSession = new ServerRoute({
		path: '/sandbox/api/sessions/:id/reject',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				await body(context.request);
				const id = sessionIdParam(context);
				const current = await readSession(runtime.workspaceRoot, id);
				assertNotDelivered(current);
				await stopIfRequested(id, {});
				const at = current.rejectedAt ?? Date.now();
				const session = await updateSession(runtime.workspaceRoot, id, {
					rejectedAt: at,
					archivedAt: at,
				});
				await preview.forget(id);
				return json({ session });
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* Rolls the session's workspace back to a captured checkpoint. The path is
	   distinct from /restore, which un-archives a session; this one replaces the
	   draft files with an earlier snapshot and keeps the transcript. A delivered
	   session refuses: its module already landed, so a new session should carry
	   any further change. */
	const restoreSandboxCheckpoint = new ServerRoute({
		path: '/sandbox/api/sessions/:id/checkpoints/restore',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const sessionId = sessionIdParam(context);
				const value = await body(context.request);
				const sequence = value.sequence;
				if (
					typeof sequence !== 'number' ||
					!Number.isInteger(sequence) ||
					sequence < 0
				) {
					throw new SandboxSetupError(
						'INVALID_INPUT',
						'sequence must be a non-negative integer.',
					);
				}
				const session = await readSession(runtime.workspaceRoot, sessionId);
				assertNotArchived(session);
				if (running.has(sessionId)) {
					throw new SandboxSetupError(
						'SESSION_RUNNING',
						'A turn is still running in this session. Stop it before restoring a checkpoint.',
					);
				}
				if (session.ejectedAt !== null) {
					throw new SandboxSetupError(
						'SESSION_DELIVERED',
						'This session was already delivered. Start a new session to change the module again.',
					);
				}
				const restored = await restoreCheckpoint(
					runtime.workspaceRoot,
					sessionId,
					sequence,
				);
				await preview.forget(sessionId);
				await notifyPlatform(restored, restored.state, context);
				return json(await sessionView(runtime, restored, false));
			} catch (error) {
				return failure(error);
			}
		},
	});

	const removeSandboxSession = new ServerRoute({
		path: '/sandbox/api/sessions/:id/delete',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const sessionId = sessionIdParam(context);
				const value = await body(context.request);
				const session = await readSession(runtime.workspaceRoot, sessionId);
				await stopIfRequested(sessionId, value);
				await preview.forget(sessionId);
				forgetDiffs(sessionId);
				await deleteSession(runtime.workspaceRoot, sessionId, {
					keepTranscript: value.keepTranscript !== false,
				});
				await notifyPlatform(session, 'deleted', context);
				return json({
					deleted: true,
					keptTranscript: value.keepTranscript !== false,
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const turn = new ServerRoute({
		path: '/sandbox/api/sessions/:id/turn',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const sessionId = sessionIdParam(context);
				const value = await body(context.request);
				assertNotArchived(await readSession(runtime.workspaceRoot, sessionId));
				const channel = startTurn(
					sessionId,
					{
						message: text(value, 'message', 20_000),
						freshContext: value.freshContext === true,
						...(optionalText(value, 'role', 64)
							? { role: text(value, 'role', 64) }
							: {}),
						...(optionalText(value, 'module', 64)
							? { module: text(value, 'module', 64) }
							: {}),
						...(optionalText(value, 'driver', 64)
							? { driver: text(value, 'driver', 64) }
							: {}),
					},
					actingPlatform(runtime, context),
				);
				return streamChannel(channel);
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* Answering the questions the last turn asked is a turn of its own: the
	   decisions lead the request text, the operator's own words follow them, and
	   the specialist that asked takes the turn in the module it asked about. */
	const answerQuestions = new ServerRoute({
		path: '/sandbox/api/sessions/:id/answers',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const sessionId = sessionIdParam(context);
				const value = await body(context.request);
				const note = optionalText(value, 'message', MAX_ANSWER_NOTE);
				let answered: AnsweredTurn | null = null;
				/* Reading the questions, resolving them and clearing them is one
				   step under the session lock: two submissions arriving together
				   must not both find the same decisions pending and start a turn
				   from them. */
				await updateSession(runtime.workspaceRoot, sessionId, (current) => {
					assertNotArchived(current);
					assertNotDelivered(current);
					const pending = current.pendingQuestions;
					if (!pending || pending.questions.length === 0) {
						throw new SandboxSetupError(
							'NO_PENDING_QUESTIONS',
							'This session is not waiting for a decision.',
						);
					}
					const resolved = resolveAnswers(pending, value.answers);
					if (!resolved.ok) {
						throw new SandboxSetupError('INVALID_INPUT', resolved.reason);
					}
					const decisions = formatDecisions(resolved.decisions);
					answered = {
						message: note ? `${decisions}\n\n${note}` : decisions,
						role: pending.role,
						...(pending.module ? { module: pending.module } : {}),
					};
					return { pendingQuestions: null };
				});
				const turn: AnsweredTurn = answered!;
				const channel = startTurn(
					sessionId,
					/* The decisions text is the specialist's own words read back, so
					   only the operator's note may name a skill for this turn. */
					{ ...turn, skillTask: note ?? '' },
					actingPlatform(runtime, context),
				);
				return streamChannel(channel);
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* Follow a turn another browser, or an earlier page load, started. */
	const followTurn = new ServerRoute({
		path: '/sandbox/api/sessions/:id/turn/stream',
		methods: ['GET'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options);
				const channel = running.get(sessionIdParam(context));
				if (!channel) return json({ running: false });
				return streamChannel(channel);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const stop = new ServerRoute({
		path: '/sandbox/api/sessions/:id/stop',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const channel = running.get(sessionIdParam(context));
				channel?.controller.abort('stopped');
				return json({ stopped: channel !== undefined });
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* The operator decides whether a handoff runs on its own. The choice belongs
	   to the session, so a long chain stays off for that session only. */
	const settings = new ServerRoute({
		path: '/sandbox/api/sessions/:id/settings',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const value = await body(context.request);
				const session = await updateSession(
					runtime.workspaceRoot,
					sessionIdParam(context),
					{ autoContinue: value.autoContinue === true },
				);
				return json({ session });
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* Approving a specification is the operator's decision, so the sandbox makes
	   it: the status line moves to approved, the approved text is recorded on
	   the module, and its implementer can start. One module at a time. */
	const approve = new ServerRoute({
		path: '/sandbox/api/sessions/:id/approve',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const session = await readSession(
					runtime.workspaceRoot,
					sessionIdParam(context),
				);
				assertNotArchived(session);
				assertNotDelivered(session);
				const value = await body(context.request);
				const module = findSessionModule(
					session,
					optionalText(value, 'module', 120),
				);
				const approved = await approveSpecification(
					runtime.workspaceRoot,
					session,
					module,
				);
				await appendChatEntry(runtime.workspaceRoot, approved.session, {
					decision: 'approved',
					kind: 'system',
					role: session.role,
					module: module.directory,
					text: `You approved the specification of ${module.id}. Implementation of modules/${module.directory} is unblocked until the specification changes again.`,
				});
				return json({
					session: approved.session,
					status: approved.status,
					module: approved.module,
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* The second answer to a review: the operator says in words what the
	   specification should say instead. The comment is the business manager's
	   next turn, and the transcript records who asked for what. */
	const requestSpecChanges = new ServerRoute({
		path: '/sandbox/api/sessions/:id/spec/changes',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const session = await readSession(
					runtime.workspaceRoot,
					sessionIdParam(context),
				);
				assertNotArchived(session);
				assertNotDelivered(session);
				const value = await body(context.request);
				const module = findSessionModule(
					session,
					optionalText(value, 'module', 120),
				);
				const comment = text(value, 'comment', MAX_SPEC_COMMENT);
				const handoff = {
					kind: 'continue' as const,
					role: SPEC_OWNER_ROLE,
					roleName:
						runtime.roles().find((role) => role.id === SPEC_OWNER_ROLE)?.name ??
						SPEC_OWNER_ROLE,
					reason: `You asked for changes to the specification of ${module.id}.`,
					prompt: [
						`The operator reviewed ${module.id} and asked for this change to the specification:`,
						comment,
						'Change spec/module.yaml to match, and nothing else. Leave status as it is: the operator approves. End with your handoff line.',
					].join('\n\n'),
					module: module.directory,
				};
				/* A review comment withdraws the prior decision immediately. The
				   business manager can then revise the same document, but no stale
				   approval can slip through an eject while that happens. */
				const awaitingRevision = await updateSession(
					runtime.workspaceRoot,
					session.id,
					{
						modules: session.modules.map((entry) =>
							entry.directory === module.directory
								? {
										id: entry.id,
										directory: entry.directory,
										kind: entry.kind,
									}
								: entry,
						),
						state: 'planned',
					},
				);
				await appendChatEntry(runtime.workspaceRoot, awaitingRevision, {
					decision: 'changes-requested',
					kind: 'user',
					role: SPEC_OWNER_ROLE,
					module: module.directory,
					text: `Requested changes to the specification of ${module.id}: ${comment}`,
					handoff,
				});
				return json({
					session: await readSession(runtime.workspaceRoot, session.id),
					handoff,
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* The third answer: the operator edits the document. Reading it needs no
	   mutation header; writing replaces the draft and says so in the transcript,
	   which also re-opens the approval gate because the text changed. */
	const readSpecDocument = new ServerRoute({
		path: '/sandbox/api/sessions/:id/spec',
		methods: ['GET'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options);
				const session = await readSession(
					runtime.workspaceRoot,
					sessionIdParam(context),
				);
				const module = findSessionModule(
					session,
					context.url.searchParams.get('module'),
				);
				return json({
					module: module.directory,
					moduleId: module.id,
					path: `modules/${module.directory}/spec/module.yaml`,
					text: await readSpecFile(runtime.workspaceRoot, session, module),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const writeSpecDocument = new ServerRoute({
		path: '/sandbox/api/sessions/:id/spec',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const sessionId = sessionIdParam(context);
				const session = await readSession(runtime.workspaceRoot, sessionId);
				assertNotArchived(session);
				assertNotDelivered(session);
				if (running.has(sessionId)) {
					throw new SandboxSetupError(
						'SESSION_RUNNING',
						'A turn is still running in this session. Wait for it or stop it before editing the specification.',
					);
				}
				const value = await body(context.request, MAX_SPEC_TEXT * 2 + 2_048);
				const module = findSessionModule(
					session,
					optionalText(value, 'module', 120),
				);
				const draft = text(value, 'text', MAX_SPEC_TEXT);
				await writeSpecFile(
					runtime.workspaceRoot,
					session,
					module,
					`${draft.trimEnd()}\n`,
				);
				forgetDiffs(sessionId);
				await appendChatEntry(runtime.workspaceRoot, session, {
					kind: 'system',
					role: session.role,
					module: module.directory,
					text: `You edited the specification of ${module.id}. Approve it to let the implementer continue.`,
				});
				return json(
					await sessionView(
						runtime,
						await readSession(runtime.workspaceRoot, sessionId),
						false,
					),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const gates = new ServerRoute({
		path: '/sandbox/api/sessions/:id/gates',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const value = await body(context.request);
				const session = await readSession(
					runtime.workspaceRoot,
					sessionIdParam(context),
				);
				const requested = Array.isArray(value.gates)
					? (value.gates as readonly string[])
					: [
							'module-schema',
							'spec-schema',
							'dependencies',
							'typecheck',
							'tests',
							'format',
						];
				const results = await runSessionGates(
					turnContext(),
					session,
					requested,
				);
				return json({ gates: results });
			} catch (error) {
				return failure(error);
			}
		},
	});

	const format = new ServerRoute({
		path: '/sandbox/api/sessions/:id/format',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const session = await readSession(
					runtime.workspaceRoot,
					sessionIdParam(context),
				);
				const results = await formatSession({
					workspaceRoot: runtime.workspaceRoot,
					paths: sessionPaths(
						runtime.workspaceRoot,
						session.id,
						session.moduleSuffix,
					),
					session,
				});
				return json({ gate: results[0], gates: results });
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* Eject is watched, not awaited in silence: the plan, every gate, the copy,
	   the install, and the enable arrive as they happen, so the operator sees
	   what landed and what is still running. The session is marked delivered
	   only when every step passed. */
	const eject = new ServerRoute({
		path: '/sandbox/api/sessions/:id/eject',
		methods: ['POST'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options, { mutation: true });
				const value = await body(context.request);
				const session = await readSession(
					runtime.workspaceRoot,
					sessionIdParam(context),
				);
				assertNotArchived(session);
				if (running.has(session.id)) {
					throw new SandboxSetupError(
						'SESSION_RUNNING',
						'A turn is still running in this session. Wait for it or stop it before delivering.',
					);
				}
				const projectDelivery = await readDeliveryConfiguration(
					runtime.workspaceRoot,
				);
				const requestedText = optionalText(value, 'target', 32);
				const requested =
					requestedText === null ? null : assertEjectTarget(requestedText);
				const configuration = runtime.configuration();
				const githubProviderDisabled =
					projectDelivery.git.provider === 'github' &&
					!configuration.github.enabled;
				if (
					requested !== null &&
					(!projectDelivery.targets.includes(requested) ||
						((requested === 'git-pr' || requested === 'official-modules') &&
							githubProviderDisabled))
				) {
					throw new SandboxSetupError(
						'EJECT_TARGET_DISABLED',
						(requested === 'git-pr' || requested === 'official-modules') &&
						githubProviderDisabled
							? 'GitHub pull request delivery is disabled in the sandbox configuration.'
							: `The ${requested} target is not enabled in flowdular.json sandbox.delivery.targets.`,
					);
				}
				const delivery =
					configuration.github.enabled && configuration.github.overridesProject
						? {
								...projectDelivery,
								git: {
									...projectDelivery.git,
									remote: configuration.github.remote,
									repository: configuration.github.repository,
									baseBranch: configuration.github.baseBranch,
									branchPrefix: configuration.github.branchPrefix,
									provider: projectDelivery.git.provider,
									mode: configuration.github.mode,
									forkOwner: configuration.github.forkOwner,
									reviewers: configuration.github.reviewers,
								},
							}
						: projectDelivery;
				const deliveryContext: DeliveryContext = {
					workspaceRoot: runtime.workspaceRoot,
					session,
					capabilities: actingCapabilities(runtime, context),
					platformUrl: configuration.platformUrl,
					build: value.build === true,
					delivery,
					gitProviderToken: () =>
						configuration.github.enabled &&
						delivery.git.provider === 'github' &&
						configuration.gitProviderToken
							? openSecret(
									runtime.workspaceRoot,
									configuration.gitProviderToken,
								)
							: Promise.resolve(null),
					runGates: (ids) => runSessionGates(turnContext(), session, ids),
					commands: spawnCommand,
				};
				const availableTargets = await Promise.all(
					delivery.targets.map(async (id) => ({
						id,
						...((id === 'git-pr' || id === 'official-modules') &&
						githubProviderDisabled
							? {
									available: false,
									reason:
										'GitHub pull request delivery is disabled in the sandbox configuration.',
								}
							: await resolveDeliveryTarget(id).available(deliveryContext)),
					})),
				);
				/* The configured default may be unusable here (no commits yet, no
				   remote). A plan request without an explicit target then falls
				   back to a usable one and says why; an explicit choice does not. */
				let chosen: EjectTarget = requested ?? delivery.default;
				const availability = availableTargets.find(
					(candidate) => candidate.id === chosen,
				);
				if (availability && !availability.available) {
					const fallback =
						requested === null && value.apply !== true
							? availableTargets.find((candidate) => candidate.available)
							: undefined;
					if (!fallback) {
						throw new SandboxSetupError(
							'EJECT_TARGET_UNAVAILABLE',
							availability.reason ?? 'The delivery target is not available.',
						);
					}
					chosen = fallback.id;
				}
				const target = resolveDeliveryTarget(chosen);
				const plan = await target.plan(deliveryContext);
				const paths = sessionPaths(
					runtime.workspaceRoot,
					session.id,
					session.moduleSuffix,
				);
				if (value.apply !== true) {
					return json({
						plan: {
							...plan,
							availableTargets,
							previous: await readDeliveryRecord(paths.root),
						},
						target: chosen,
						availableTargets,
					});
				}

				const encoder = new TextEncoder();
				const stream = new ReadableStream<Uint8Array>({
					async start(controller) {
						let closed = false;
						const send = (event: string, payload: unknown) => {
							if (closed) return;
							try {
								controller.enqueue(
									encoder.encode(
										`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
									),
								);
							} catch {
								closed = true;
							}
						};
						try {
							send('plan', plan);
							const outcome = await target.apply(deliveryContext, plan, send);
							const ejectedAt = Date.now();
							await updateSession(runtime.workspaceRoot, session.id, {
								state: 'accepted',
								ejectedAt,
							});
							const record = await writeDeliveryRecord(paths.root, {
								target: plan.target,
								deliveredAt: ejectedAt,
								modules: plan.modules.map((module) => module.id),
								branch: outcome.branch ?? null,
								pullRequestUrl: outcome.pullRequestUrl ?? null,
								compareUrl: outcome.compareUrl ?? null,
							});
							const platform = actingPlatform(runtime, context);
							if (platform && session.registeredWithPlatform) {
								await platform
									.updateSessionState(session.id, 'accepted')
									.catch(() => undefined);
								await platform
									.recordEject(session.id, {
										target: plan.target,
										modules: plan.modules.map((module) => module.id).join(' '),
										files: outcome.files,
										removed: outcome.removed,
										enabled: outcome.enabled,
										gates: outcome.gates.length,
										...(record.branch ? { branch: record.branch } : {}),
										...(record.pullRequestUrl
											? { pullRequestUrl: record.pullRequestUrl }
											: {}),
									})
									.catch(() => undefined);
							}
							send('done', {
								target: plan.target,
								moduleId: outcome.moduleId,
								modules: plan.modules.map((module) => module.id),
								targetPath: outcome.targetPath,
								files: outcome.files,
								removed: outcome.removed,
								enabled: outcome.enabled,
								ejectedAt,
								gates: outcome.gates,
								restartRequired: outcome.restartRequired,
								platformLocal: plan.platformLocal,
								branch: record.branch,
								pullRequestUrl: record.pullRequestUrl,
								compareUrl: record.compareUrl,
							});
						} catch (error) {
							send('failed', {
								code:
									error instanceof SandboxSetupError
										? error.code
										: 'EJECT_FAILED',
								message:
									error instanceof Error ? error.message : 'The eject failed.',
								...(error instanceof DeliveryError
									? { output: error.output }
									: {}),
							});
						} finally {
							if (!closed) {
								closed = true;
								controller.close();
							}
						}
					},
				});
				return new Response(stream, {
					headers: {
						'content-type': 'text/event-stream; charset=utf-8',
						'cache-control': 'no-store',
						connection: 'keep-alive',
					},
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	const previewInfo = new ServerRoute({
		path: '/sandbox/api/sessions/:id/preview',
		methods: ['GET'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options);
				const session = await readSession(
					runtime.workspaceRoot,
					sessionIdParam(context),
				);
				const composition = await preview.compose(session);
				return json({
					moduleId: composition.moduleId,
					modules: composition.modules,
					revision: composition.revision,
					scopes: composition.moduleScopes,
					credentials: composition.credentials,
					routes: composition.routes.length,
					error: composition.error,
				});
			} catch (error) {
				return failure(error);
			}
		},
	});

	/* The composed preview API. The draft modules answer first with their own
	   routes and the session's own ephemeral database, the session's
	   authentication routes answer next, and only what is left falls through to
	   the connected application. The preview page is the sandbox's own page, so
	   it carries the sandbox session like every other request. */
	const previewApi = new ServerRoute({
		path: '/api/*path',
		methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
		handler: async (context) => {
			try {
				await authorize(runtime, context, options);
				/* A draft module's own fetch carries no sandbox header, so the
				   preview mutation boundary is the browser origin checked here.
				   The worker hop below runs on its own loopback origin. */
				if (
					context.request.method !== 'GET' &&
					context.request.method !== 'HEAD'
				) {
					assertBrowserOrigin(context.request);
				}
			} catch (error) {
				return failure(error);
			}
			const sessionId = previewSessionId(context);
			let composition: PreviewComposition | null = null;
			if (sessionId) {
				try {
					composition = await preview.compose(
						await readSession(runtime.workspaceRoot, sessionId),
					);
				} catch {
					composition = null;
				}
			}
			if (composition) {
				/* Draft routes and their authentication runtime execute in a bounded
				   loopback worker. A worker miss deliberately falls through to the
				   read-only bridge, never to an import in this server process. */
				const response = await composition.request(context.request);
				if (response.headers.get('x-flowdular-preview-unmatched') !== '1') {
					return response;
				}
			}
			return bridgeRequest(context);
		},
	});

	/* The read-only preview data bridge. Anything the draft modules do not
	   serve is answered by the connected application under the acting
	   principal's grant. */
	const bridgeRequest = async (context: Context): Promise<Response> => {
		const configuration = runtime.configuration();
		const platform = actingPlatform(runtime, context);
		if (configuration.previewData !== 'bridge' || !platform) {
			return json(
				{
					error: {
						code: 'BRIDGE_DISABLED',
						message:
							'This preview runs on fixtures. Switch preview data to bridge to read live platform data.',
					},
				},
				404,
			);
		}
		if (BRIDGE_DENIED.some((pattern) => pattern.test(context.url.pathname))) {
			return json(
				{
					error: {
						code: 'BRIDGE_PATH_DENIED',
						message:
							'The preview bridge does not forward authentication or sandbox records.',
					},
				},
				403,
			);
		}
		if (
			!actingCapabilities(runtime, context).includes('sandbox.preview.data')
		) {
			return json(
				{
					error: {
						code: 'BRIDGE_SCOPE_MISSING',
						message: 'The sandbox grant does not include sandbox.preview.data.',
					},
				},
				403,
			);
		}
		const response = await platform.bridge({
			method: context.request.method,
			path: context.url.pathname,
			search: context.url.search,
			accept: context.request.headers.get('accept'),
		});
		return new Response(response.body, {
			status: response.status,
			headers: {
				'content-type': response.contentType,
				'cache-control': 'no-store',
				'x-flowdular-bridge': 'platform',
			},
		});
	};

	return [
		state,
		configure,
		connect,
		createSandboxSession,
		readSandboxSession,
		addSandboxModule,
		addSandboxAttachment,
		removeSandboxAttachment,
		serveSandboxAttachment,
		archiveSandboxSession,
		rejectSandboxSession,
		restoreSandboxSession,
		restoreSandboxCheckpoint,
		removeSandboxSession,
		turn,
		answerQuestions,
		followTurn,
		stop,
		settings,
		approve,
		requestSpecChanges,
		readSpecDocument,
		writeSpecDocument,
		gates,
		format,
		eject,
		previewInfo,
		previewApi,
	];
}
