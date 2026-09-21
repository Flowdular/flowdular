import {
	applicationBrandingFrom,
	BRANDING_DATA_ELEMENT_ID,
	BRANDING_NAME_PROPERTY,
	DEFAULT_APPLICATION_BRANDING,
	type ApplicationBranding,
} from '@flowdular/contracts';

export type ApplicationBrandingProvider = () => ApplicationBranding;

/* One provider per process, installed by the module that owns the settings
   the values come from. The server package never reads a module's storage, so
   the direction stays module to platform, exactly as the module activation
   gate is installed. */
let provider: ApplicationBrandingProvider | null = null;

export function installApplicationBranding(
	next: ApplicationBrandingProvider | null,
): void {
	provider = next;
}

/**
 * The branding of this deployment, or the product's own values when no module
 * installed a provider, the settings behind it are not loaded yet, or the
 * provider failed. A document is never refused over its decoration.
 */
export function currentApplicationBranding(): ApplicationBranding {
	if (!provider) return DEFAULT_APPLICATION_BRANDING;
	try {
		return applicationBrandingFrom(
			provider() as unknown as Record<string, unknown>,
		);
	} catch {
		return DEFAULT_APPLICATION_BRANDING;
	}
}

function jsonBlock(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

/**
 * What the application document needs before its bundle runs: the values as a
 * JSON data block the client adopts on hydration, and the name as a custom
 * property, so the boot splash paints the deployment's own name rather than
 * the product's while the shell is still loading.
 */
export function brandingHeadInsert(branding: ApplicationBranding): string {
	const name = branding.appName.replace(/["\\]/g, '\\$&');
	return (
		`<script id="${BRANDING_DATA_ELEMENT_ID}" type="application/json">${jsonBlock(branding)}</script>` +
		`<style>:root{${BRANDING_NAME_PROPERTY}:"${name}"}</style>`
	);
}
