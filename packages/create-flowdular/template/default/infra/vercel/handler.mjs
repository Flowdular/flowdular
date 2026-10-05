/* Vercel assigns a different origin to every preview. Read its own deployment
   hostname before importing Octane, whose auth runtime captures the origin at boot. */
process.env.NODE_ENV = 'production';
process.env.FD_DEPLOYMENT_TARGET = 'vercel';
process.env.FD_TRUST_PROXY = 'true';
process.env.FD_AUTH_SECURE_COOKIE = 'true';
if (!process.env.FD_AUTH_PUBLIC_ORIGIN && process.env.VERCEL_URL) {
	const host = process.env.VERCEL_URL;
	if (
		!/^[-a-z0-9.]+$/i.test(host) ||
		host.startsWith('.') ||
		host.endsWith('.') ||
		host.includes('..') ||
		!host.includes('.')
	) {
		throw new Error('VERCEL_URL must be a hostname without a scheme or path.');
	}
	process.env.FD_AUTH_PUBLIC_ORIGIN = `https://${host}`;
}

/* Vercel Cron presents CRON_SECRET as its bearer token, so the tick secret is
   that value unless the deployment names its own. */
if (!process.env.FD_WORKER_TICK_SECRET && process.env.CRON_SECRET) {
	process.env.FD_WORKER_TICK_SECRET = process.env.CRON_SECRET;
}

const { nodeHandler } = await import('./platform/dist/server/entry.js');

const WORKER_TICK_PATH = '/api/internal/worker/tick';
const KICK_INTERVAL_MS = 5_000;
/* The worker function keeps running after this request hangs up: Vercel ends
   an invocation on disconnect only for functions that opt into cancellation. */
const KICK_HANDOFF_MS = 2_000;
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
let lastKick = 0;

function kickWorker(origin, secret) {
	const now = Date.now();
	if (now - lastKick < KICK_INTERVAL_MS) return Promise.resolve();
	lastKick = now;
	const headers = { authorization: `Bearer ${secret}` };
	if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
		headers['x-vercel-protection-bypass'] =
			process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
	}
	return fetch(new URL(WORKER_TICK_PATH, origin), {
		method: 'POST',
		headers,
		signal: AbortSignal.timeout(KICK_HANDOFF_MS),
	}).then(
		(response) => response.body?.cancel(),
		() => undefined,
	);
}

/* The web function claims no queued work, so a request that changed state asks
   the worker function for a short tick instead of leaving it to the next cron. */
function withWorkerKick(handler) {
	const origin = process.env.FD_AUTH_PUBLIC_ORIGIN;
	const secret = process.env.FD_WORKER_TICK_SECRET;
	if (process.env.FD_RUNTIME_ROLE !== 'web' || !origin || !secret) {
		return handler;
	}
	return (request, response) => {
		const waitUntil = globalThis[REQUEST_CONTEXT]?.get?.()?.waitUntil;
		if (
			waitUntil &&
			!['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
			request.url?.startsWith('/api/')
		) {
			waitUntil(
				new Promise((resolve) => {
					response.once('close', () => {
						resolve(
							response.statusCode < 400
								? kickWorker(origin, secret)
								: undefined,
						);
					});
				}),
			);
		}
		return handler(request, response);
	};
}

/* Vercel terminates TLS before the function, and Octane's Node adapter builds
   every request URL as http://<host>. An absolute https target keeps the
   origin that same-origin checks compare against. */
function withHttpsOrigin(handler) {
	return (request, response) => {
		const host = request.headers?.host;
		if (host && request.url?.startsWith('/')) {
			request.url = `https://${host}${request.url}`;
		}
		return handler(request, response);
	};
}

export default withWorkerKick(withHttpsOrigin(nodeHandler));
