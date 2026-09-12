import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	defineEndpoint,
	jsonResponse,
	serverMetrics,
	type MetricsRegistry,
} from '@flowdular/server';
import type { ServerRoute } from '@octanejs/app-core';

const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
const BEARER = /^Bearer (.+)$/i;

export interface MetricsRoutesOptions {
	readonly environment?: NodeJS.ProcessEnv;
	readonly metrics?: MetricsRegistry;
	readonly version?: string;
}

function exposed(value: string | undefined): boolean {
	if (value === undefined || value.trim() === '') return false;
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new Error('FD_METRICS must be true or false.');
}

/* Both this source file and the bundled server entry sit two directories below
   platform/package.json, which the container image ships next to dist/. */
function platformVersion(): string {
	try {
		const manifest: unknown = JSON.parse(
			readFileSync(
				join(import.meta.dirname, '..', '..', 'package.json'),
				'utf8',
			),
		);
		const version = (manifest as { version?: unknown }).version;
		return typeof version === 'string' && version ? version : 'unknown';
	} catch {
		return 'unknown';
	}
}

/* Comparing digests keeps the operands the same length, so neither the timing
   nor a length check tells a caller how long the configured token is. */
function tokenMatches(header: string | null, token: string): boolean {
	const presented = BEARER.exec(header ?? '')?.[1];
	if (presented === undefined) return false;
	return timingSafeEqual(
		createHash('sha256').update(presented).digest(),
		createHash('sha256').update(token).digest(),
	);
}

/**
 * Prometheus exposition for this process. Composed only when `FD_METRICS=true`,
 * and readable only with `FD_METRICS_TOKEN` when that is set. The series carry
 * endpoint ids, never a request path, a session or tenant data.
 */
export function createMetricsRoutes(
	options: MetricsRoutesOptions = {},
): readonly ServerRoute[] {
	const environment = options.environment ?? process.env;
	if (!exposed(environment.FD_METRICS)) return [];
	const token = environment.FD_METRICS_TOKEN?.trim() || null;
	const metrics = options.metrics ?? serverMetrics();
	metrics.setBuildVersion(options.version ?? platformVersion());
	const endpoint = defineEndpoint({
		id: 'system.metrics',
		path: '/api/metrics',
		methods: ['GET'],
		access: { kind: 'public' },
		handler: ({ octane }) => {
			if (
				token &&
				!tokenMatches(octane.request.headers.get('authorization'), token)
			) {
				const denied = jsonResponse(
					{
						error: {
							code: 'UNAUTHENTICATED',
							message: 'Authentication is required.',
						},
					},
					401,
				);
				denied.headers.set('www-authenticate', 'Bearer');
				return denied;
			}
			return new Response(metrics.expose(), {
				headers: {
					'content-type': CONTENT_TYPE,
					'cache-control': 'no-store',
				},
			});
		},
	});
	return [endpoint.serverRoute];
}
