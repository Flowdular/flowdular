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

/**
 * A view's address for a caller the shell hands no state to: a widget or panel
 * a module contributes reads the open workspace back from the address bar,
 * because the slug the shell's own `viewHref` takes is state it never sees. A
 * single segment under the base is the view itself, and the shell resolves that
 * slugless form against the open workspace, so a server render lands there too.
 */
export function workspaceViewHref(
	viewId: string,
	pathname: string = typeof window === 'undefined'
		? ''
		: window.location.pathname,
	base: string = basePath,
): string {
	const segments = pathname.split('/').filter(Boolean);
	const inWorkspace = segments[0] === base.slice(1) ? segments.slice(1) : [];
	const workspaceSlug = inWorkspace.length > 1 ? inWorkspace[0] : null;
	return workspaceSlug === null
		? base + '/' + viewId
		: base + '/' + workspaceSlug + '/' + viewId;
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
