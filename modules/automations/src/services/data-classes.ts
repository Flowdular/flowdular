import type {
	DataClassDeclaration,
	DataClassExportSummary,
} from '@flowdular/kernel';
import type { AutomationsRepository } from './repository.ts';

/** Rows one keyset page carries. Bounded so a walk never loads a whole table. */
export const AUDIT_EXPORT_PAGE = 500;

/**
 * The classes automations.core owns. Schedules and triggers are configuration a
 * person manages rather than history that ages, so the trail is the only class
 * here: it is what the workspace accumulates.
 *
 * It carries no sweep. The trail is hash chained per workspace, every event
 * naming the hash of the one before it, and verifyAuditChain walks it from
 * sequence 1 with no previous hash. Deleting the oldest events by age would
 * leave the first surviving event pointing at a row that is gone, so the next
 * verification would report the chain broken and could not tell retention from
 * tampering. audit.core keeps its own chained ledgers for the same reason. The
 * precise fix is chain archival, sealing a removed prefix under one anchor
 * event; until that exists these rows are kept until a person deletes them.
 *
 * The repository arrives as a thunk because declaring happens while the
 * platform composes, before anything has opened a database.
 */
export function automationsDataClasses(
	repository: () => Promise<AutomationsRepository>,
	pageSize = AUDIT_EXPORT_PAGE,
): readonly DataClassDeclaration[] {
	return [
		{
			key: 'audit-events',
			label: 'Automation audit trail',
			defaultRetentionDays: null,
			exportable: true,
			export: async ({ tenantId, sink }): Promise<DataClassExportSummary> => {
				let afterId = '';
				let rows = 0;
				let from: Date | null = null;
				let to: Date | null = null;
				for (;;) {
					const page = await (
						await repository()
					).exportAuditEventsPage(tenantId, afterId, pageSize);
					for (const event of page) {
						const at = new Date(event.occurredAt);
						if (!from || at < from) from = at;
						if (!to || at > to) to = at;
						afterId = event.id;
						rows += 1;
						await sink.write({
							...event,
							occurredAt: at.toISOString(),
						});
					}
					if (page.length < pageSize) return { rows, from, to };
				}
			},
		},
	];
}
