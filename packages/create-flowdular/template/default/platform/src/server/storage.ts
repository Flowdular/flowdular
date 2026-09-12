import { defineEndpoint } from '@flowdular/sdk/server';
import {
	createStoragePort,
	createStorageKeyring,
	openStorageReadToken,
	StorageError,
	storageConfigFromEnvironment,
	STORAGE_READ_ROUTE_PREFIX,
	type StorageConfig,
	type StoragePort,
	type StoragePortOptions,
} from '@flowdular/sdk/storage';
import type { Keyring } from '@flowdular/sdk/kernel';
import type { ServerRoute } from '@octanejs/app-core';

export {
	createStoragePort,
	createStorageKeyring,
	storageConfigFromEnvironment,
	STORAGE_READ_ROUTE_PREFIX,
};
export type {
	StorageConfig as PlatformStorageConfig,
	StoragePort as PlatformStoragePort,
	StoragePortOptions as PlatformStoragePortOptions,
};

const RATE_LIMIT = 600;
const RATE_WINDOW_MS = 60_000;
const RATE_CAPACITY = 4_096;

/**
 * Fixed window per caller, bounded. Expired windows are dropped once the map
 * reaches capacity, so a flood of distinct tokens cannot grow it without limit.
 */
class ReadRateLimiter {
	readonly #windows = new Map<string, { count: number; startedAt: number }>();

	allow(key: string, now: number): boolean {
		const current = this.#windows.get(key);
		if (current && now - current.startedAt < RATE_WINDOW_MS) {
			current.count += 1;
			return current.count <= RATE_LIMIT;
		}
		if (this.#windows.size >= RATE_CAPACITY) this.#evict(now);
		this.#windows.set(key, { count: 1, startedAt: now });
		return true;
	}

	#evict(now: number): void {
		for (const [key, window] of this.#windows) {
			if (now - window.startedAt >= RATE_WINDOW_MS) this.#windows.delete(key);
		}
		while (this.#windows.size >= RATE_CAPACITY) {
			const oldest = this.#windows.keys().next();
			if (oldest.done) return;
			this.#windows.delete(oldest.value);
		}
	}
}

const ADDRESS_PATTERN = /^[0-9a-fA-F.:]{3,45}$/;

/* Octane hands routes a Web Request without the socket address, so the client
   is only known behind a proxy this deployment trusts. Without one the window
   is keyed by the token, which still bounds replay of a single read URL. The
   capability itself is what resists guessing: a token carries a 16 byte
   authentication tag. */
function limiterKey(
	request: Request,
	trustProxy: boolean,
	token: string,
): string {
	if (trustProxy) {
		const first = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
		if (first && ADDRESS_PATTERN.test(first))
			return `ip:${first.toLowerCase()}`;
	}
	return `token:${token.slice(0, 32)}`;
}

function notFound(requestId: string): Response {
	return Response.json(
		{
			error: {
				code: 'NOT_FOUND',
				message: 'The requested object is not available.',
			},
			requestId,
		},
		{ status: 404, headers: { 'cache-control': 'private, no-store' } },
	);
}

export interface StorageRoutesOptions {
	readonly storage: StoragePort;
	readonly keyring: Keyring;
	readonly environment?: NodeJS.ProcessEnv | undefined;
	readonly clock?: (() => Date) | undefined;
}

/**
 * `GET /api/storage/objects/:token` streams the decrypted body of one object.
 * The token is the capability: it is sealed under the storage keyring, names
 * the tenant, module, object and expiry, and needs no session, which is why
 * this route has no 401 and answers 404 to everything it cannot serve. A
 * different answer for an expired token, a forged one and a deleted object
 * would tell a caller which of the three it holds.
 */
export function createStorageRoutes(
	options: StorageRoutesOptions,
): readonly ServerRoute[] {
	const environment = options.environment ?? process.env;
	const trustProxy = environment.FD_TRUST_PROXY === 'true';
	const clock = options.clock ?? (() => new Date());
	const limiter = new ReadRateLimiter();
	const endpoint = defineEndpoint({
		id: 'system.storage.read',
		path: `${STORAGE_READ_ROUTE_PREFIX}:token`,
		methods: ['GET'],
		access: { kind: 'public' },
		handler: async ({ octane, requestId }) => {
			const token = octane.params.token ?? '';
			const now = clock();
			if (
				!limiter.allow(
					limiterKey(octane.request, trustProxy, token),
					now.getTime(),
				)
			) {
				return Response.json(
					{
						error: { code: 'RATE_LIMITED', message: 'Too many object reads.' },
						requestId,
					},
					{
						status: 429,
						headers: {
							'cache-control': 'private, no-store',
							'retry-after': '60',
						},
					},
				);
			}
			const reference = openStorageReadToken(options.keyring, token, now);
			if (!reference) return notFound(requestId);
			let result;
			try {
				result = await options.storage.get(reference);
			} catch (error) {
				/* A frame this keyring cannot open is indistinguishable from an absent
				   object to the reader, and saying so would leak that it exists. An
				   adapter outage is a real 500 and stays one. */
				if (error instanceof StorageError && error.code === 'OBJECT_CORRUPT') {
					return notFound(requestId);
				}
				throw error;
			}
			if (!result) return notFound(requestId);
			return new Response(result.body, {
				headers: {
					'content-type': result.object.contentType,
					'content-length': String(result.object.bytes),
					'content-disposition': 'attachment',
					'cache-control': 'private, no-store',
					'x-content-type-options': 'nosniff',
				},
			});
		},
	});
	return [endpoint.serverRoute];
}
