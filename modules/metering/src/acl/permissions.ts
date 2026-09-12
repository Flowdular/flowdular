export const METERING_PERMISSIONS = {
	read: 'metering.usage.read',
} as const;

export const permissions = Object.freeze(Object.values(METERING_PERMISSIONS));
