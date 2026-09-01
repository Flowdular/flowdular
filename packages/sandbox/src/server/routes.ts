import { ServerRoute, type Context } from '@octanejs/app-core';
import {
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
import { assertBrief, listWorkspaceModules, planWork } from './planning.ts';
import {
	collectDiffs,
	forgetDiffs,
	runSessionGates,
	runTurn,
	type TurnContext,
	type TurnOutcome,
} from './turns.ts';
import {
	appendChatEntry,
	approveSpecification,
	archiveSession,
	assertSessionId,
	createSession,
	deleteSession,
	installSessionDependencies,
	isSessionId,
	listSessions,
	readChat,
	readSession,
	restoreSession,
	sessionPaths,
	updateSession,
	type SandboxSession,
} from './sessions.ts';
import type { BrowserSession, SandboxRuntime } from './runtime.ts';
import { SandboxSetupError } from './workspace-root.ts';

const SANDBOX_COOKIE = 'coreloom_sandbox';
/* Every sandbox mutation carries this header. A cross-site form post cannot
   set it, so together with the origin check it is the CSRF boundary. */
export const SANDBOX_REQUEST_HEADER = 'x-coreloom-sandbox';
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
	EJECT_SCOPE_MISSING: 403,
	SESSION_NOT_FOUND: 404,
	SESSION_RUNNING: 409,
	SESSION_ARCHIVED: 409,
};

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

async function body(request: Request): Promise<Record<string, unknown>> {
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
	const value = (await request.json()) as unknown;
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

/* Mutations must come from the sandbox's own page: the fetch metadata or the
   Origin header must name this origin, and the custom header must be present.
   A cross-site form post can satisfy neither. */
export function assertSameOrigin(request: Request): void {
	const site = request.headers.get('sec-fetch-site');
	if (site && site !== 'same-origin' && site !== 'none') {
		throw new SandboxSetupError(
			'SANDBOX_CROSS_SITE',
			'Sandbox mutations are accepted from the sandbox page only.',
		);
	}
	const origin = request.headers.get('origin');
	if (origin) {
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
function authorize(
	runtime: SandboxRuntime,
	context: Context,
	options: SandboxRouteOptions,
	policy: AuthorizeOptions = {},
): void {
	if (policy.mutation) assertSameOrigin(context.request);
	if (runtime.configuration().mode === 'loopback') {
		assertLoopbackHost(context.request, options.port);
		if (!policy.allowDisconnected && !runtime.connection().connected) {
			throw new SandboxSetupError(
				runtime.connection().error?.code ?? 'SANDBOX_NOT_CONNECTED',
				runtime.connection().error?.message ??
					'The sandbox is not connected to a Coreloom application yet.',
			);
		}
		return;
	}
	if (!browserSession(runtime, context)) {
		throw new SandboxSetupError(
			'SANDBOX_SIGN_IN_REQUIRED',
			'Connect this browser with an API token issued by the Coreloom application.',
		);
	}
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

type Subscriber = (event: string, payload: unknown) => void;

/* A turn, or a chain of automatically continued turns, runs to completion on
   the server whatever happens to the browser. Streams subscribe to it and can
   leave at any time; stopping is an explicit action. The finished promise is
   kept with the controller because a superseding turn must wait for the old
   process to release the driver's thread before it resumes it. */
interface TurnChannel {
	readonly controller: AbortController;
	readonly finished: Promise<void>;
	readonly subscribers: Set<Subscriber>;
}

export function createSandboxRoutes(
	runtime: SandboxRuntime,
	preview: PreviewRuntime,
	options: SandboxRouteOptions = {},
): readonly ServerRoute[] {
	const running = new Map<string, TurnChannel>();
	const secureCookies = runtime.configuration().mode !== 'loopback';

	const turnContext = (): TurnContext => ({
		workspaceRoot: runtime.workspaceRoot,
		configuration: runtime.configuration(),
		registry: runtime.registry(),
		roles: runtime.roles(),
		platform: runtime.platform(),
	});

	const settled = (channel: TurnChannel): Promise<unknown> =>
		Promise.race([
			channel.finished,
			new Promise((resolveTimeout) => {
				const timer = setTimeout(resolveTimeout, 20_000);
				timer.unref?.();
			}),
		]);

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
		input: { message: string; role?: string; driver?: string },
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
				if (previous) await settled(previous);
				await updateSession(runtime.workspaceRoot, sessionId, {
					chainDepth: 0,
				});
				let next: { message: string; role?: string; driver?: string } | null =
					input;
				let depth = 0;
				while (next && !controller.signal.aborted) {
					const iterator = runTurn(turnContext(), {
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
				authorize(runtime, context, options, { allowDisconnected: true });
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
			return json({
				configuration: safeConfiguration(configuration),
				connection: runtime.connection(),
				drivers: await runtime.registry().status(),
				roles: runtime.roles().map((role) => ({
					id: role.id,
					name: role.name,
					purpose: role.purpose,
					allowedPaths: role.allowedPaths,
					gates: role.gates,
					handoff: role.handoff,
				})),
				sessions: await listSessions(runtime.workspaceRoot),
				running: [...running.keys()],
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
				authorize(runtime, context, options, {
					allowDisconnected: true,
					mutation: true,
				});
				const value = await body(context.request);
				const token = optionalText(value, 'platformToken', 4_096);
				const byokCredential = optionalText(value, 'byokCredential', 16_384);
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
					...(value.byokKind === undefined
						? {}
						: {
								byok: {
									kind: text(value, 'byokKind', 40) as never,
									model: text(value, 'byokModel', 160),
									...(optionalText(value, 'byokResourceName', 160)
										? { resourceName: text(value, 'byokResourceName', 160) }
										: {}),
									...(optionalText(value, 'byokBaseUrl', 2_048)
										? { baseURL: text(value, 'byokBaseUrl', 2_048) }
										: {}),
									credential: byokCredential
										? await sealSecret(runtime.workspaceRoot, byokCredential)
										: (configuration.byok?.credential ?? null),
								},
							}),
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
				authorize(runtime, context, options, { mutation: true });
				const value = await body(context.request);
				const brief = assertBrief(text(value, 'brief', 20_000));
				const configuration = runtime.configuration();
				const driver =
					optionalText(value, 'driver', 64) ?? configuration.driver;
				const plan = await planWork({
					brief,
					driver,
					registry: runtime.registry(),
					roles: runtime.roles(),
					modules: await listWorkspaceModules(runtime.workspaceRoot),
				});

				const session = await createSession({
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

				const platform = runtime.platform();
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
				authorize(runtime, context, options);
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
		await settled(channel);
	};

	const notifyPlatform = async (
		session: SandboxSession,
		state: string,
	): Promise<void> => {
		if (!session.registeredWithPlatform) return;
		await runtime
			.platform()
			?.updateSessionState(session.id, state)
			.catch(() => undefined);
	};

	const archiveSandboxSession = new ServerRoute({
		path: '/sandbox/api/sessions/:id/archive',
		methods: ['POST'],
		handler: async (context) => {
			try {
				authorize(runtime, context, options, { mutation: true });
				const sessionId = sessionIdParam(context);
				const value = await body(context.request);
				await readSession(runtime.workspaceRoot, sessionId);
				await stopIfRequested(sessionId, value);
				const session = await archiveSession(runtime.workspaceRoot, sessionId);
				preview.forget(sessionId);
				await notifyPlatform(session, 'archived');
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
				authorize(runtime, context, options, { mutation: true });
				const sessionId = sessionIdParam(context);
				await body(context.request);
				const session = await restoreSession(runtime.workspaceRoot, sessionId);
				await notifyPlatform(session, session.state);
				return json({ session });
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
				authorize(runtime, context, options, { mutation: true });
				const sessionId = sessionIdParam(context);
				const value = await body(context.request);
				const session = await readSession(runtime.workspaceRoot, sessionId);
				await stopIfRequested(sessionId, value);
				preview.forget(sessionId);
				forgetDiffs(sessionId);
				await deleteSession(runtime.workspaceRoot, sessionId, {
					keepTranscript: value.keepTranscript !== false,
				});
				await notifyPlatform(session, 'deleted');
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
				authorize(runtime, context, options, { mutation: true });
				const sessionId = sessionIdParam(context);
				const value = await body(context.request);
				assertNotArchived(await readSession(runtime.workspaceRoot, sessionId));
				const channel = startTurn(sessionId, {
					message: text(value, 'message', 20_000),
					...(optionalText(value, 'role', 64)
						? { role: text(value, 'role', 64) }
						: {}),
					...(optionalText(value, 'driver', 64)
						? { driver: text(value, 'driver', 64) }
						: {}),
				});
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
		handler: (context) => {
			try {
				authorize(runtime, context, options);
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
		handler: (context) => {
			try {
				authorize(runtime, context, options, { mutation: true });
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
				authorize(runtime, context, options, { mutation: true });
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
	   it: the status line moves to approved and the implementer can start. */
	const approve = new ServerRoute({
		path: '/sandbox/api/sessions/:id/approve',
		methods: ['POST'],
		handler: async (context) => {
			try {
				authorize(runtime, context, options, { mutation: true });
				const session = await readSession(
					runtime.workspaceRoot,
					sessionIdParam(context),
				);
				assertNotArchived(session);
				const approved = await approveSpecification(
					runtime.workspaceRoot,
					session,
				);
				return json({ session: approved.session, status: approved.status });
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
				authorize(runtime, context, options, { mutation: true });
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
				authorize(runtime, context, options, { mutation: true });
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
				authorize(runtime, context, options, { mutation: true });
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
				const delivery = await readDeliveryConfiguration(runtime.workspaceRoot);
				const requestedText = optionalText(value, 'target', 32);
				const requested =
					requestedText === null ? null : assertEjectTarget(requestedText);
				if (requested !== null && !delivery.targets.includes(requested)) {
					throw new SandboxSetupError(
						'EJECT_TARGET_DISABLED',
						`The ${requested} target is not enabled in coreloom.json sandbox.delivery.targets.`,
					);
				}
				const configuration = runtime.configuration();
				const deliveryContext: DeliveryContext = {
					workspaceRoot: runtime.workspaceRoot,
					session,
					capabilities: actingCapabilities(runtime, context),
					platformUrl: configuration.platformUrl,
					build: value.build === true,
					delivery,
					gitProviderToken: () =>
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
						...(await resolveDeliveryTarget(id).available(deliveryContext)),
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
							const platform = runtime.platform();
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
				authorize(runtime, context, options);
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
				authorize(runtime, context, options);
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
			const match = composition?.router.match(
				context.request.method,
				context.url.pathname,
			);
			if (composition && match && match.route.type === 'server') {
				context.params = match.params;
				/* The session's authentication middleware resolves the preview
				   cookie into a principal, exactly as the platform does, so the
				   draft module's own identity and permission checks run for real. */
				return composition.auth.middleware(context, async () =>
					(match.route as ServerRoute).handler(context),
				);
			}
			return bridgeRequest(context);
		},
	});

	/* The read-only preview data bridge. Anything the draft modules do not
	   serve is answered by the connected application under the acting
	   principal's grant. */
	const bridgeRequest = async (context: Context): Promise<Response> => {
		const configuration = runtime.configuration();
		const platform = runtime.platform();
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
				'x-coreloom-bridge': 'platform',
			},
		});
	};

	return [
		state,
		configure,
		connect,
		createSandboxSession,
		readSandboxSession,
		archiveSandboxSession,
		restoreSandboxSession,
		removeSandboxSession,
		turn,
		followTurn,
		stop,
		settings,
		approve,
		gates,
		format,
		eject,
		previewInfo,
		previewApi,
	];
}
