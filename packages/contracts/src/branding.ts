/* The identity one deployment shows: the name in its navigation, the title of
   its documents, the image a shared link previews with, its icon and its
   colour. system.core stores these as platform-scoped settings and the
   application route hands them to the document; the shapes and the defaults
   live here so the setting declaration, the server and the client never
   restate them differently. */

/** The module that declares these settings; the same one that owns the time zone. */
export const BRANDING_MODULE_ID = 'system.core';
/** Every branding key, in the order an operator reads them on the screen. */
export const BRANDING_SETTING_KEYS = [
	'appName',
	'documentTitle',
	'logoUrl',
	'faviconUrl',
	'themeColor',
	'description',
	'ogImageUrl',
] as const;

/** Page state key the application route sets and the render reads. */
export const BRANDING_STATE_KEY = 'flowdular.branding';
/** Data block the same values travel in to the browser, for hydration. */
export const BRANDING_DATA_ELEMENT_ID = 'flowdular-branding-data';
/** Custom property the boot splash reads before any bundle has loaded. */
export const BRANDING_NAME_PROPERTY = '--flowdular-brand';

export interface ApplicationBranding {
	readonly appName: string;
	/** Browser tab suffix when it differs from `appName`; empty means `appName`. */
	readonly documentTitle: string;
	/** Empty means the shell's own translated description. */
	readonly description: string;
	readonly ogImageUrl: string;
	readonly faviconUrl: string;
	readonly themeColor: string;
	/** Empty means the built-in mark. */
	readonly logoUrl: string;
}

export const DEFAULT_APPLICATION_BRANDING: ApplicationBranding = Object.freeze({
	appName: 'Flowdular',
	documentTitle: '',
	description: '',
	ogImageUrl: '/og.png',
	faviconUrl: '/favicon.svg',
	themeColor: '#141B2E',
	logoUrl: '',
});

export const BRANDING_NAME_MAX = 64;
export const BRANDING_TITLE_MAX = 120;
export const BRANDING_DESCRIPTION_MAX = 200;
export const BRANDING_URL_MAX = 512;

/* A value that reaches the document head or an image source carries no
   markup, no quote and no control character, so a stored setting can never
   break out of the attribute or the CSS string it is written into. */
const TEXT_BODY = '[^<>"\'\\\\\\p{Cc}]';
export const BRANDING_NAME_PATTERN = `${TEXT_BODY}{1,${BRANDING_NAME_MAX}}`;
export const BRANDING_TITLE_PATTERN = `|${TEXT_BODY}{1,${BRANDING_TITLE_MAX}}`;
export const BRANDING_DESCRIPTION_PATTERN = `|${TEXT_BODY}{1,${BRANDING_DESCRIPTION_MAX}}`;

/* An address is this deployment's own absolute path or an https URL. A
   protocol-relative "//host" and a "\\host" both reach another origin from a
   value that looks like a path, so the first character after the slash is
   neither; javascript: and data: never match at all. */
const ASSET_URL = `/(?![/\\\\])[^\\s<>"'\\\\]{0,${BRANDING_URL_MAX - 1}}|https://[^\\s<>"'\\\\/]{1,255}(?:/[^\\s<>"']{0,${BRANDING_URL_MAX - 1}})?`;
export const BRANDING_ASSET_URL_PATTERN = ASSET_URL;
/** The same address, or nothing at all. */
export const BRANDING_OPTIONAL_ASSET_URL_PATTERN = `|${ASSET_URL}`;
export const BRANDING_COLOR_PATTERN = '#[0-9a-fA-F]{6}';

interface BrandingField {
	readonly pattern: string;
	readonly max: number;
}

const FIELDS: Readonly<Record<keyof ApplicationBranding, BrandingField>> = {
	appName: { pattern: BRANDING_NAME_PATTERN, max: BRANDING_NAME_MAX },
	documentTitle: {
		pattern: BRANDING_TITLE_PATTERN,
		max: BRANDING_TITLE_MAX,
	},
	description: {
		pattern: BRANDING_DESCRIPTION_PATTERN,
		max: BRANDING_DESCRIPTION_MAX,
	},
	ogImageUrl: { pattern: BRANDING_ASSET_URL_PATTERN, max: BRANDING_URL_MAX },
	faviconUrl: { pattern: BRANDING_ASSET_URL_PATTERN, max: BRANDING_URL_MAX },
	themeColor: { pattern: BRANDING_COLOR_PATTERN, max: 7 },
	logoUrl: {
		pattern: BRANDING_OPTIONAL_ASSET_URL_PATTERN,
		max: BRANDING_URL_MAX,
	},
};

/* One compiled expression per field, built once: every application document
   resolves its branding, so the request path must not recompile them. */
const EXPRESSIONS = new Map<string, RegExp>(
	Object.entries(FIELDS).map(([key, field]) => [
		key,
		new RegExp(`^(?:${field.pattern})$`, 'u'),
	]),
);

export function isBrandingValue(
	key: keyof ApplicationBranding,
	value: unknown,
): value is string {
	const field = FIELDS[key];
	return (
		typeof value === 'string' &&
		value.length <= field.max &&
		EXPRESSIONS.get(key)!.test(value)
	);
}

/**
 * The branding a document renders, from whatever was stored or transported.
 * Every field is checked again here rather than trusted: a value stored before
 * its declaration changed, or a data block an extension rewrote, falls back to
 * the product default instead of reaching the head.
 */
export function applicationBrandingFrom(
	values: Readonly<Record<string, unknown>> | null | undefined,
): ApplicationBranding {
	if (!values) return DEFAULT_APPLICATION_BRANDING;
	const resolved: Record<string, string> = {};
	for (const key of BRANDING_SETTING_KEYS) {
		const value = values[key];
		resolved[key] = isBrandingValue(key, value)
			? value
			: DEFAULT_APPLICATION_BRANDING[key];
	}
	return resolved as unknown as ApplicationBranding;
}

/** Suffix of the browser tab title: the document title when set, else the name. */
export function brandingTitleSuffix(branding: ApplicationBranding): string {
	return branding.documentTitle || branding.appName;
}

/**
 * Origins of the branding images, for the `img-src` of the content security
 * policy. A same-origin path needs no entry; an https address does, or the
 * browser blocks the icon, the logo and the Branding screen's own preview with
 * nothing in the document to explain why. Only what an operator stored is
 * named, so the widening is theirs.
 */
export function brandingImageOrigins(
	branding: ApplicationBranding,
): readonly string[] {
	const origins = new Set<string>();
	for (const value of [
		branding.faviconUrl,
		branding.logoUrl,
		branding.ogImageUrl,
	]) {
		if (!value.startsWith('https://')) continue;
		try {
			origins.add(new URL(value).origin);
		} catch {
			// A stored value this runtime cannot parse grants no origin.
		}
	}
	return [...origins];
}
