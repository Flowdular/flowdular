import type { DatabaseHandle } from '@flowdular/database';
import { runDatabaseMigrations } from '@flowdular/database';
import { databaseMigrations } from './migration.ts';
import type {
	ModuleActivationRecord,
	ModuleActivationRepository,
} from './repository.ts';

interface ActivationRow {
	tenant_id: string;
	module_id: string;
	active: number | bigint | string;
	changed_by: string;
	changed_at: number | bigint | string;
}

const SQL = {
	list: `SELECT tenant_id, module_id, active, changed_by, changed_at
	 FROM system_module_activations
	 WHERE tenant_id = $1
	 ORDER BY module_id`,
	set: `INSERT INTO system_module_activations
	 (tenant_id, module_id, active, changed_by, changed_at)
	 VALUES ($1, $2, $3, $4, $5)
	 ON CONFLICT (tenant_id, module_id) DO UPDATE
	 SET active = EXCLUDED.active,
	     changed_by = EXCLUDED.changed_by,
	     changed_at = EXCLUDED.changed_at
	 WHERE system_module_activations.tenant_id = $1`,
} as const;

/* PostgreSQL returns BIGINT as a string, and a flag column as a number this
   module compares only after normalizing. */
function integer(value: number | bigint | string, field: string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized) || normalized < 0) {
		throw new Error(`The system database returned an invalid ${field}.`);
	}
	return normalized;
}

function fromRow(row: ActivationRow): ModuleActivationRecord {
	return {
		tenantId: row.tenant_id,
		moduleId: row.module_id,
		active: integer(row.active, 'flag') === 1,
		changedBy: row.changed_by,
		changedAt: integer(row.changed_at, 'timestamp'),
	};
}

export class DatabaseModuleActivationRepository
	implements ModuleActivationRepository
{
	constructor(private readonly database: DatabaseHandle) {}

	async list(tenantId: string): Promise<readonly ModuleActivationRecord[]> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<ActivationRow>({
					text: SQL.list,
					parameters: [tenantId],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromRow);
	}

	async set(record: ModuleActivationRecord): Promise<void> {
		await this.database.transaction(
			(transaction) =>
				transaction.execute({
					text: SQL.set,
					parameters: [
						record.tenantId,
						record.moduleId,
						record.active ? 1 : 0,
						record.changedBy,
						record.changedAt,
					],
				}),
			{ access: 'write', tenantId: record.tenantId },
		);
	}
}

export async function migrateSystemDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'system.core', databaseMigrations);
}
