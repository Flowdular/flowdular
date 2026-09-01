import type { Context } from '@octanejs/app-core';
import { AuthServiceError } from '../services/auth-service-error.ts';

export function assertSameOrigin(context: Context): void {
	const site = context.request.headers.get('sec-fetch-site');
	if (site === 'cross-site' || site === 'same-site') {
		throw new AuthServiceError(
			'CROSS_ORIGIN_REQUEST',
			'Cross-origin request rejected.',
			403,
		);
	}

	const origin = context.request.headers.get('origin');
	if (origin) {
		if (origin !== context.url.origin) {
			throw new AuthServiceError(
				'CROSS_ORIGIN_REQUEST',
				'Request origin does not match.',
				403,
			);
		}
		return;
	}

	const referer = context.request.headers.get('referer');
	if (referer) {
		try {
			if (new URL(referer).origin === context.url.origin) return;
		} catch {
			// The generic failure below does not disclose header parsing details.
		}
	}

	throw new AuthServiceError(
		'ORIGIN_REQUIRED',
		'A same-origin request is required.',
		403,
	);
}
