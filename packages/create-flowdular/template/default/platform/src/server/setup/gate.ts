import { ServerRoute, type Context, type Middleware } from '@octanejs/app-core';

export interface FirstRunGate {
	/** Runs ahead of authentication. Until a workspace exists it answers every
	 *  request itself, except the pass-through paths. */
	readonly middleware: Middleware;
	/** Global middleware runs only for a matched route, so /setup needs one. */
	readonly routes: readonly ServerRoute[];
}

export interface FirstRunGateOptions {
	readonly applicationPath: string;
	/** Served normally before the first workspace exists, such as /api/ready. */
	readonly passThrough: readonly string[];
	readonly workspaceExists: () => Promise<boolean>;
	/** Builds the /setup handler. `claimed` opens this instance at once. */
	readonly setup: (
		claimed: () => void,
	) => (context: Context) => Promise<Response>;
}

function redirect(location: string): Response {
	return new Response(null, {
		status: 303,
		headers: { location, 'cache-control': 'no-store' },
	});
}

export function createFirstRunGate(options: FirstRunGateOptions): FirstRunGate {
	let open = false;
	let checking: Promise<boolean> | null = null;
	const setup = options.setup(() => {
		open = true;
	});
	/* Asked on every request until it first answers yes, so an instance that
	   did not run setup itself opens on its next request after another did.
	   Concurrent requests share one query; a failed one keeps the gate shut. */
	const workspaceExists = (): Promise<boolean> =>
		(checking ??= options.workspaceExists().then(
			(exists) => {
				checking = null;
				if (exists) open = true;
				return exists;
			},
			() => {
				checking = null;
				return false;
			},
		));
	const middleware: Middleware = async (context, next) => {
		if (open || (await workspaceExists())) return next();
		const { pathname } = context.url;
		if (pathname === '/setup') return setup(context);
		if (options.passThrough.includes(pathname)) return next();
		const method = context.request.method;
		if (
			(method === 'GET' || method === 'HEAD') &&
			pathname !== '/api' &&
			!pathname.startsWith('/api/')
		) {
			return redirect('/setup');
		}
		return Response.json(
			{
				error: {
					code: 'PLATFORM_NOT_CONFIGURED',
					message:
						'Complete the first-run setup at /setup before using the platform.',
				},
			},
			{ status: 503, headers: { 'cache-control': 'no-store' } },
		);
	};
	return {
		middleware,
		routes: [
			new ServerRoute({
				path: '/setup',
				methods: ['GET', 'POST'],
				handler: () => redirect(options.applicationPath),
			}),
		],
	};
}
