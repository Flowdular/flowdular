import {
	BRANDING_ASSET_URL_PATTERN,
	BRANDING_COLOR_PATTERN,
	BRANDING_DESCRIPTION_MAX,
	BRANDING_DESCRIPTION_PATTERN,
	BRANDING_NAME_MAX,
	BRANDING_NAME_PATTERN,
	BRANDING_OPTIONAL_ASSET_URL_PATTERN,
	BRANDING_TITLE_MAX,
	BRANDING_TITLE_PATTERN,
	BRANDING_URL_MAX,
	DEFAULT_APPLICATION_BRANDING,
} from '@flowdular/contracts';
import { defineModuleSettings } from '@flowdular/kernel';
import {
	DEFAULT_TIME_ZONE,
	MAX_TIME_ZONE_LENGTH,
	SYSTEM_MODULE_ID,
	TIME_ZONE_PATTERN,
} from './domain/time-zone.ts';

/* The branding is one identity for the installation: the sign-in screen and a
   shared link are rendered before any workspace is known, so a per-workspace
   value would have no answer there. Every one of them is sent to the client,
   because the document the client renders is where they are read. */
const BRANDING_SCOPE = 'platform' as const;

export const SYSTEM_MODULE_SETTINGS = defineModuleSettings({
	moduleId: SYSTEM_MODULE_ID,
	settings: {
		timeZone: {
			type: 'string',
			defaultValue: DEFAULT_TIME_ZONE,
			visibility: 'shared',
			client: false,
			scope: 'tenant',
			min: 1,
			max: MAX_TIME_ZONE_LENGTH,
			pattern: TIME_ZONE_PATTERN,
			labelKey: 'system.settings.timeZone.label',
			label: 'Workspace time zone',
			descriptionKey: 'system.settings.timeZone.description',
			description:
				'IANA zone name such as Europe/Warsaw. Modules that show or schedule local times read it; the default is UTC.',
		},
		appName: {
			type: 'string',
			defaultValue: DEFAULT_APPLICATION_BRANDING.appName,
			visibility: 'shared',
			client: true,
			scope: BRANDING_SCOPE,
			min: 1,
			max: BRANDING_NAME_MAX,
			pattern: BRANDING_NAME_PATTERN,
			labelKey: 'system.settings.appName.label',
			label: 'Application name',
			descriptionKey: 'system.settings.appName.description',
			description:
				'Shown in the navigation, the mobile header and the boot screen, and used as the browser tab suffix unless a document title overrides it.',
		},
		documentTitle: {
			type: 'string',
			defaultValue: DEFAULT_APPLICATION_BRANDING.documentTitle,
			visibility: 'shared',
			client: true,
			scope: BRANDING_SCOPE,
			max: BRANDING_TITLE_MAX,
			pattern: BRANDING_TITLE_PATTERN,
			labelKey: 'system.settings.documentTitle.label',
			label: 'Document title',
			descriptionKey: 'system.settings.documentTitle.description',
			description:
				'Browser tab suffix, when it should differ from the application name. Empty uses the name.',
		},
		description: {
			type: 'string',
			defaultValue: DEFAULT_APPLICATION_BRANDING.description,
			visibility: 'shared',
			client: true,
			scope: BRANDING_SCOPE,
			max: BRANDING_DESCRIPTION_MAX,
			pattern: BRANDING_DESCRIPTION_PATTERN,
			multiline: true,
			labelKey: 'system.settings.brandingDescription.label',
			label: 'Description',
			descriptionKey: 'system.settings.brandingDescription.description',
			description:
				'Description of the document and of a shared link. Empty uses the application shell description.',
		},
		ogImageUrl: {
			type: 'string',
			defaultValue: DEFAULT_APPLICATION_BRANDING.ogImageUrl,
			visibility: 'shared',
			client: true,
			scope: BRANDING_SCOPE,
			min: 1,
			max: BRANDING_URL_MAX,
			pattern: BRANDING_ASSET_URL_PATTERN,
			labelKey: 'system.settings.ogImageUrl.label',
			label: 'Link preview image',
			descriptionKey: 'system.settings.ogImageUrl.description',
			description:
				'Image a shared link previews with. An address on this deployment, such as /og.png, or an https URL.',
		},
		faviconUrl: {
			type: 'string',
			defaultValue: DEFAULT_APPLICATION_BRANDING.faviconUrl,
			visibility: 'shared',
			client: true,
			scope: BRANDING_SCOPE,
			min: 1,
			max: BRANDING_URL_MAX,
			pattern: BRANDING_ASSET_URL_PATTERN,
			labelKey: 'system.settings.faviconUrl.label',
			label: 'Browser icon',
			descriptionKey: 'system.settings.faviconUrl.description',
			description:
				'Icon of the browser tab. An address on this deployment, such as /favicon.svg, or an https URL.',
		},
		themeColor: {
			type: 'string',
			defaultValue: DEFAULT_APPLICATION_BRANDING.themeColor,
			visibility: 'shared',
			client: true,
			scope: BRANDING_SCOPE,
			min: 7,
			max: 7,
			pattern: BRANDING_COLOR_PATTERN,
			labelKey: 'system.settings.themeColor.label',
			label: 'Theme colour',
			descriptionKey: 'system.settings.themeColor.description',
			description:
				'Colour a mobile browser paints its chrome with, as a six-digit hex value such as #141B2E.',
		},
		logoUrl: {
			type: 'string',
			defaultValue: DEFAULT_APPLICATION_BRANDING.logoUrl,
			visibility: 'shared',
			client: true,
			scope: BRANDING_SCOPE,
			max: BRANDING_URL_MAX,
			pattern: BRANDING_OPTIONAL_ASSET_URL_PATTERN,
			labelKey: 'system.settings.logoUrl.label',
			label: 'Logo',
			descriptionKey: 'system.settings.logoUrl.description',
			description:
				'Image shown instead of the built-in mark in the navigation. An address on this deployment or an https URL; empty keeps the built-in mark.',
		},
	},
});
