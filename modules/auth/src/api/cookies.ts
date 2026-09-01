export interface AuthCookieConfig {
	readonly name: string;
	readonly secure: boolean;
	readonly maxAgeSeconds: number;
}

export function readCookie(
	request: globalThis.Request,
	name: string,
): string | null {
	const header = request.headers.get('cookie');
	if (!header) return null;
	for (const item of header.split(';')) {
		const separator = item.indexOf('=');
		if (separator < 1) continue;
		const key = item.slice(0, separator).trim();
		if (key !== name) continue;
		try {
			return decodeURIComponent(item.slice(separator + 1).trim());
		} catch {
			return null;
		}
	}
	return null;
}

export function sessionCookie(token: string, config: AuthCookieConfig): string {
	return [
		`${config.name}=${encodeURIComponent(token)}`,
		'Path=/',
		'HttpOnly',
		'SameSite=Strict',
		`Max-Age=${config.maxAgeSeconds}`,
		config.secure ? 'Secure' : '',
	]
		.filter(Boolean)
		.join('; ');
}

export function expiredSessionCookie(config: AuthCookieConfig): string {
	return [
		`${config.name}=`,
		'Path=/',
		'HttpOnly',
		'SameSite=Strict',
		'Max-Age=0',
		'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
		config.secure ? 'Secure' : '',
	]
		.filter(Boolean)
		.join('; ');
}
