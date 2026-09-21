import {
	applicationBrandingFrom,
	BRANDING_DATA_ELEMENT_ID,
	BRANDING_STATE_KEY,
	DEFAULT_APPLICATION_BRANDING,
	type ApplicationBranding,
} from '@flowdular/contracts';

/* The deployment's own identity, resolved by the server once per document.
   Held as one value the shell and the application entry read synchronously:
   the wordmark and the document title are rendered before anything could be
   fetched, and a second source would let them disagree. */
let branding: ApplicationBranding = DEFAULT_APPLICATION_BRANDING;

export function configureApplicationBranding(
	values: Readonly<Record<string, unknown>> | null | undefined,
): void {
	branding = applicationBrandingFrom(values);
}

export function applicationBranding(): ApplicationBranding {
	return branding;
}

/**
 * Select the server's branding during SSR and browser hydration, the way
 * `configureApplicationFromPage` selects the installation path: the render
 * receives it as page state, the browser reads the data block the same
 * response carried. A document without either keeps the product defaults.
 */
export function configureBrandingFromPage(
	props: { readonly state?: Map<string, unknown> } | undefined,
): void {
	const state = props?.state?.get(BRANDING_STATE_KEY);
	if (state && typeof state === 'object') {
		configureApplicationBranding(state as Record<string, unknown>);
		return;
	}
	if (typeof document === 'undefined') return;
	const data = document.getElementById(BRANDING_DATA_ELEMENT_ID)?.textContent;
	if (!data) return;
	try {
		const parsed: unknown = JSON.parse(data);
		if (parsed && typeof parsed === 'object') {
			configureApplicationBranding(parsed as Record<string, unknown>);
		}
	} catch {
		// A data block this browser cannot parse leaves the defaults standing.
	}
}
