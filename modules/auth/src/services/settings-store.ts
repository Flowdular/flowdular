import {
	assertSettingValue,
	type ModuleSettingChangeContext,
	type ModuleSettingsStore,
	type ModuleSettingValue,
} from '@flowdular/kernel';
import { AUDIT_ACTIONS } from './auth-service.ts';
import type {
	AuthRepository,
	SettingsChangeAudit,
	SettingsChangeEvent,
	SettingsWriteResult,
} from './repository.ts';

/** Owed platform events one pass writes, and old rows it prunes per tenant. */
export const SETTINGS_LOG_SWEEP_BATCH = 500;

/**
 * The kernel settings store over auth.core's module_settings table and its
 * change log. The kernel runtime primes a snapshot per tenant through `load`,
 * revalidates it against the log, and awaits every write, so a failure
 * reaches the caller that made it.
 */
export function createAuthSettingsStore(
	repository: () => Promise<AuthRepository>,
): ModuleSettingsStore {
	return {
		load: async (tenantId, moduleId) =>
			(await repository()).loadSettings(tenantId, moduleId),
		save: async (record, change) => {
			const resolved = await repository();
			return committed(
				resolved,
				await resolved.saveSetting(
					record,
					settingsAudit(change, record.moduleId, record.key, record.value),
				),
			);
		},
		clear: async (tenantId, moduleId, key, change) => {
			const resolved = await repository();
			return committed(
				resolved,
				await resolved.clearSetting(
					tenantId,
					moduleId,
					key,
					settingsAudit(change, moduleId, key, null),
				),
			);
		},
		newestRevision: async () => (await repository()).newestSettingsRevision(),
		changesAfter: async (request) =>
			(await repository()).settingsChangesAfter(request),
	};
}

/**
 * One pass of the settings log upkeep: writes every workspace event a platform
 * change still owes, then prunes superseded rows past the retention period.
 * A change whose event cannot be written stays marked for the next pass and
 * does not hold up the others.
 */
export async function sweepSettingsLog(
	repository: AuthRepository,
	batch: number = SETTINGS_LOG_SWEEP_BATCH,
): Promise<void> {
	let failed = 0;
	for (const revision of await repository.pendingSettingsAudits(batch)) {
		try {
			await repository.completeSettingsAudit(revision, platformSettingsEvent);
		} catch {
			failed += 1;
		}
	}
	await repository.deleteSupersededSettingsChanges(batch);
	if (failed > 0) {
		throw new Error(`${failed} owed platform settings events stay pending.`);
	}
}

async function committed(
	repository: AuthRepository,
	result: SettingsWriteResult,
): Promise<{ readonly revision: number }> {
	if (result.auditPending) {
		/* The value is committed, so the save resolves; the mark keeps the event
		   owed and the sweep writes it. The driver error is not printed: it can
		   carry the statement's bound values. */
		await repository
			.completeSettingsAudit(result.revision, platformSettingsEvent)
			.catch(() =>
				console.error(
					'[auth.core] platform settings event deferred to the sweep',
				),
			);
	}
	return { revision: result.revision };
}

/* A flag is tenant scoped, so a platform change is always an ordinary one. */
function platformSettingsEvent(cleared: boolean): SettingsChangeEvent {
	return { action: AUDIT_ACTIONS.settingsUpdated, metadata: { cleared } };
}

function settingsAudit(
	change: ModuleSettingChangeContext | undefined,
	moduleId: string,
	key: string,
	value: ModuleSettingValue | null,
): SettingsChangeAudit {
	/* The change row and the event name the account behind the write, so a
	   write without one is refused rather than recorded anonymously. */
	if (!change) {
		throw new Error(
			`auth.core refuses ${moduleId}.${key}: a settings write needs its change context.`,
		);
	}
	const { definition } = change;
	const cleared = value === null;
	return {
		actor: change.actor,
		event: (stored) => {
			if (definition.kind !== 'flag') {
				return { action: AUDIT_ACTIONS.settingsUpdated, metadata: { cleared } };
			}
			let previous = definition.defaultValue;
			if (stored !== undefined) {
				try {
					previous = assertSettingValue(moduleId, key, definition, stored);
				} catch {
					// A stored value that no longer fits was served as the default.
				}
			}
			return {
				action: AUDIT_ACTIONS.settingsFlagChanged,
				metadata: {
					cleared,
					previous,
					next: value ?? definition.defaultValue,
				},
			};
		},
	};
}
