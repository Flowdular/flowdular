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
