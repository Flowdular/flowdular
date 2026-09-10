let basePath = '/app';

/** Installation-wide value emitted by the CLI, never a request/tenant setting. */
export function configureApplicationRouting(path: string): void {
	if (
		path.length > 64 ||
		!/^\/[a-z][a-z0-9-]*$/.test(path) ||
		[
			'setup',
			'health',
			'ready',
			'assets',
			'auth',
			'api',
			'sites',
			'sign-in',
			'sign-up',
			'forgot-password',
			'reset-password',
			'accept-invitation',
		].includes(path.slice(1))
	)
		throw new Error('Invalid application path.');
	basePath = path;
}

export function applicationPath(): string {
	return basePath;
}

/** Select the server's installation setting during SSR and browser hydration. */
export function configureApplicationFromPage(
	props: { readonly state?: Map<string, unknown> } | undefined,
	fallback = '/app',
): void {
	let path = props?.state?.get('flowdular.application.path');
	if (path === undefined && typeof document !== 'undefined') {
		const data = document.getElementById(
			'flowdular-application-data',
		)?.textContent;
		if (data) path = JSON.parse(data);
	}
	if (path !== undefined && typeof path !== 'string')
		throw new Error('Invalid application path.');
	configureApplicationRouting(path ?? fallback);
}
