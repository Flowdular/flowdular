import { applicationPath } from '@flowdular/client/routing';

/* The server binds the preview's API requests to the session this cookie
   names (`PREVIEW_COOKIE` in the preview runtime). */
export const PREVIEW_COOKIE = 'flowdular_preview';

const SESSION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PreviewAddress {
	/* Empty when neither the address nor the preview cookie names a session. */
	readonly sessionId: string;
	/* The application shell wrote this address, so it names the view to open. */
	readonly inShell: boolean;
}

/* The preview opens at /preview/<session>, then the application shell moves
   the address to its own routes, which carry no session. A reload or a deep
   link there belongs to the session whose API the page already uses. */
export function readPreviewAddress(
	url: string,
	cookies: string,
): PreviewAddress {
	const segments = new URL(url, 'http://sandbox.local').pathname
		.split('/')
		.filter(Boolean);
	if (segments[0] === 'preview') {
		return { sessionId: segments[1] ?? '', inShell: false };
	}
	if (segments[0] !== applicationPath().slice(1)) {
		return { sessionId: '', inShell: false };
	}
	for (const cookie of cookies.split(';')) {
		const separator = cookie.indexOf('=');
		if (separator < 0) continue;
		if (cookie.slice(0, separator).trim() !== PREVIEW_COOKIE) continue;
		const value = cookie.slice(separator + 1).trim();
		return { sessionId: SESSION_ID.test(value) ? value : '', inShell: true };
	}
	return { sessionId: '', inShell: true };
}
