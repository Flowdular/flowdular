import {
	MODULE_SETTINGS_CHANGES_PAGE_MAX,
	type ModuleSettingChangesPage,
	type ModuleSettingLogEntry,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';
import { serverLogger } from '@flowdular/server';
import {
	TENANT_TIME_ZONE_KEY,
	TENANT_TIME_ZONE_MODULE_ID,
} from '../domain/time-zone.ts';

/**
 * Workspaces whose failed retiming one pass carries into the next. Past it the
 * list is dropped and the next pass reads the log from its start, which names
 * every workspace's newest change again.
 */
export const TIME_ZONE_RETRY_LIMIT = 1_000;

/** Whether a workspace's cron slots wait this pass. */
export type TimeZoneHold = (tenantId: string) => boolean;

export interface TimeZoneFollowerOptions {
	readonly settings: Pick<ModuleSettingsRuntime, 'changesAfter'>;
	/** Applies one workspace's newest change; idempotent per revision. */
	readonly apply: (change: ModuleSettingLogEntry) => Promise<unknown>;
}

export interface TimeZoneFollower {
	/**
	 * Applies every workspace zone change the log holds after the cursor and
	 * answers which workspaces' cron slots must wait this pass: those whose
	 * retiming failed, or every workspace when the log could not be read.
	 */
	pass(): Promise<TimeZoneHold>;
}

const HOLD_NONE: TimeZoneHold = () => false;
const HOLD_ALL: TimeZoneHold = () => true;

export function createTimeZoneFollower(
	options: TimeZoneFollowerOptions,
): TimeZoneFollower {
	/* An optimisation only: without a cursor the log is read from its start,
	   and a workspace already at a change's revision is skipped. */
	let cursor: string | null = null;
	let owed = new Map<string, ModuleSettingLogEntry>();

	const read = async (
		after: string | null,
	): Promise<ModuleSettingChangesPage> =>
		options.settings.changesAfter({
			after,
			limit: MODULE_SETTINGS_CHANGES_PAGE_MAX,
			moduleId: TENANT_TIME_ZONE_MODULE_ID,
			key: TENANT_TIME_ZONE_KEY,
		});

	return {
		async pass() {
			const retry = owed;
			owed = new Map();
			const failed = new Set<string>();
			const apply = async (change: ModuleSettingLogEntry): Promise<void> => {
				try {
					await options.apply(change);
				} catch (error) {
					failed.add(change.tenantId);
					owed.set(change.tenantId, change);
					serverLogger().error('automations.core time zone retiming failed', {
						module: 'automations.core',
						err: error,
					});
				}
			};
			try {
				for (;;) {
					let page = await read(cursor);
					if (page.expired) {
						cursor = null;
						page = await read(null);
						if (page.expired) {
							throw new Error(
								'The settings log refused a read from its start.',
							);
						}
					}
					const newest = new Map<string, ModuleSettingLogEntry>();
					for (const change of page.changes) {
						newest.set(change.tenantId, change);
					}
					for (const change of newest.values()) {
						const earlier = retry.get(change.tenantId);
						retry.delete(change.tenantId);
						await apply(
							earlier && earlier.revision > change.revision ? earlier : change,
						);
					}
					cursor = page.cursor;
					if (!page.more) break;
				}
				for (const change of retry.values()) await apply(change);
			} catch (error) {
				for (const [tenantId, change] of retry) owed.set(tenantId, change);
				serverLogger().error(
					'automations.core could not read time zone changes; cron slots wait',
					{ module: 'automations.core', err: error },
				);
				return HOLD_ALL;
			}
			if (owed.size > TIME_ZONE_RETRY_LIMIT) {
				owed = new Map();
				cursor = null;
			}
			return failed.size === 0 ? HOLD_NONE : (tenantId) => failed.has(tenantId);
		},
	};
}
