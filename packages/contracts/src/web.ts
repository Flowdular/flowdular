/**
 * Address segments the application itself answers on. A mount may not take one,
 * or a public page would shadow the shell, the API or a sign-in screen. The
 * server enforces it when it composes routes and the CLI refuses a mount that
 * names one, so both read the same list.
 */
export const RESERVED_WEB_SEGMENTS: readonly string[] = Object.freeze([
	'setup',
	'health',
	'ready',
	'assets',
	'app',
	'api',
	'auth',
	'sign-in',
	'sign-up',
	'forgot-password',
	'reset-password',
	'accept-invitation',
]);

/*
 * A segment is lower-case, and may carry dots inside it so a page can answer at
 * a name a reader or a crawler expects: rss.xml, sitemap.xml, robots.txt. Each
 * dot separates two non-empty groups, which is what keeps "..", a leading dot
 * and a trailing dot out of an address.
 */
const SEGMENT = '[a-z0-9-]+(?:\\.[a-z0-9-]+)*';

/** A mount address: the site root, or segments under it. */
export const WEB_MOUNT_PATH = new RegExp(`^(?:/|/${SEGMENT}(?:/${SEGMENT})*)$`);

/** A page address inside a surface, where a segment may also be a parameter. */
export const WEB_PAGE_PATH = new RegExp(
	`^(?:/|(?:/(?:${SEGMENT}|:[a-z][a-zA-Z0-9]*))+)$`,
);

/** Addresses are operator configuration, never module-supplied tenant authority. */
export interface WebMount {
	readonly id: string;
	readonly moduleId: string;
	readonly surfaceId: string;
	readonly path: string;
	readonly tenantId: string;
	readonly enabled?: boolean;
}

export interface WebIdentity {
	readonly subjectId: string;
	readonly tenantId: string;
	readonly permissions: ReadonlySet<string>;
}

export type WebAccess =
	| { readonly kind: 'public' }
	| { readonly kind: 'authenticated' }
	| { readonly kind: 'permission'; readonly permission: string };
export type WebJson =
	| null
	| boolean
	| number
	| string
	| readonly WebJson[]
	| { readonly [key: string]: WebJson };

export interface WebPageContext {
	readonly site: Readonly<WebMount>;
	/** Always null on public pages, regardless of the visitor's dashboard session. */
	readonly identity: WebIdentity | null;
	readonly params: Readonly<Record<string, string>>;
	readonly url: URL;
	readonly signal: AbortSignal;
}

export interface WebPage {
	readonly id: string;
	/** Relative to the configured mount; / is its index. */
	readonly path: string;
	/** A browser-safe package export, such as ['Page', '@example/blog/web']. */
	readonly entry: readonly [string, string];
	readonly layout?: string;
	readonly access: WebAccess;
	/** Explicit DTO boundary. Return a Response for a redirect, denial or 404. */
	readonly load: (
		context: WebPageContext,
	) => WebJson | Response | Promise<WebJson | Response>;
}

export interface ModuleWebSurface {
	readonly id: string;
	readonly pages: readonly WebPage[];
}

export interface WebModuleComposition {
	readonly moduleId?: string;
	readonly web?: readonly ModuleWebSurface[];
}
