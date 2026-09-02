import { createServer } from 'node:http';
import { createRouter, type ServerRoute } from '@octanejs/app-core';
import { createInProcessPreviewRuntime } from './preview-runtime.ts';
import type { SandboxSession } from './sessions.ts';

const workspaceRoot = process.argv[2];
if (!workspaceRoot)
	throw new Error('The preview worker requires a workspace path.');

const runtime = createInProcessPreviewRuntime(workspaceRoot);

async function readBody(
	request: import('node:http').IncomingMessage,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

function send(
	response: import('node:http').ServerResponse,
	value: Response,
): void {
	response.statusCode = value.status;
	for (const [name, content] of value.headers)
		response.setHeader(name, content);
	void value.arrayBuffer().then((body) => response.end(Buffer.from(body)));
}

async function compose(request: Request): Promise<Response> {
	const session = (await request.json()) as SandboxSession;
	const composition = await runtime.compose(session);
	return Response.json({
		sessionId: composition.sessionId,
		revision: composition.revision,
		moduleId: composition.moduleId,
		modules: composition.modules,
		credentials: composition.credentials,
		moduleScopes: composition.moduleScopes,
		error: composition.error,
		routes: composition.routes.length,
	});
}

async function previewRequest(request: Request): Promise<Response> {
	const sessionId = request.headers.get('x-coreloom-preview-session');
	if (!sessionId)
		return Response.json(
			{
				error: {
					code: 'PREVIEW_SESSION_REQUIRED',
					message: 'A preview session is required.',
				},
			},
			{ status: 400 },
		);
	const composition = runtime.cached(sessionId);
	if (!composition)
		return new Response(null, {
			status: 404,
			headers: { 'x-coreloom-preview-unmatched': '1' },
		});
	const url = new URL(request.url);
	const match = composition.router.match(request.method, url.pathname);
	if (!match || match.route.type !== 'server') {
		return new Response(null, {
			status: 404,
			headers: { 'x-coreloom-preview-unmatched': '1' },
		});
	}
	const context = {
		request,
		params: match.params,
		url,
		state: new Map(),
	};
	return composition.auth.middleware(context, async () =>
		(match.route as ServerRoute).handler(context),
	);
}

const server = createServer(async (incoming, outgoing) => {
	try {
		const origin = `http://127.0.0.1:${(incoming.socket.address() as { port: number }).port}`;
		const body = await readBody(incoming);
		const request = new Request(new URL(incoming.url ?? '/', origin), {
			method: incoming.method ?? 'GET',
			headers: incoming.headers as HeadersInit,
			...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
		});
		if (
			new URL(request.url).pathname === '/compose' &&
			request.method === 'POST'
		) {
			send(outgoing, await compose(request));
			return;
		}
		if (new URL(request.url).pathname.startsWith('/request/')) {
			const path =
				new URL(request.url).pathname.slice('/request'.length) +
				new URL(request.url).search;
			const forwarded = new Request(new URL(path, origin), {
				method: request.method,
				headers: request.headers,
				...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
			});
			send(outgoing, await previewRequest(forwarded));
			return;
		}
		send(
			outgoing,
			Response.json(
				{
					error: {
						code: 'PREVIEW_WORKER_ROUTE_NOT_FOUND',
						message: 'Preview worker route not found.',
					},
				},
				{ status: 404 },
			),
		);
	} catch (error) {
		send(
			outgoing,
			Response.json(
				{
					error: {
						code: 'PREVIEW_WORKER_FAILED',
						message:
							error instanceof Error
								? error.message.slice(0, 300)
								: 'Preview worker failed.',
					},
				},
				{ status: 500 },
			),
		);
	}
});

server.listen(0, '127.0.0.1', () => {
	const address = server.address();
	if (!address || typeof address === 'string')
		throw new Error('Preview worker did not bind a loopback port.');
	process.send?.({ type: 'ready', port: address.port });
});

const shutdown = () => server.close(() => process.exit(0));
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
/* An IPC disconnect means the sandbox generation that owned this worker is
   gone. Do not leave a preview server orphaned across shutdown or HMR. */
process.once('disconnect', shutdown);
