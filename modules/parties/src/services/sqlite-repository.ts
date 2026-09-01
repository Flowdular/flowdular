import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Party } from '../domain/types.ts';
import { PARTIES_MIGRATION_001 } from './migration.ts';
import type { PartyRepository } from './repository.ts';

interface PartyRow {
	id: string;
	tenant_id: string;
	name: string;
	kind: Party['kind'];
	email: string | null;
	phone: string | null;
	status: Party['status'];
	created_at: number;
}

function fromRow(row: PartyRow): Party {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		name: row.name,
		kind: row.kind,
		email: row.email,
		phone: row.phone,
		status: row.status,
		createdAt: row.created_at,
	};
}

export class SqlitePartyRepository implements PartyRepository {
	readonly #database: DatabaseSync;

	constructor(path: string) {
		if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
		this.#database = new DatabaseSync(path, { timeout: 5000 });
		this.#database.exec('PRAGMA journal_mode = WAL;');
		this.#database.exec(PARTIES_MIGRATION_001);
	}

	list(tenantId: string): readonly Party[] {
		return (
			this.#database
				.prepare(
					`SELECT id, tenant_id, name, kind, email, phone, status, created_at
					 FROM parties WHERE tenant_id = ?
					 ORDER BY lower(name), id`,
				)
				.all(tenantId) as unknown as PartyRow[]
		).map(fromRow);
	}

	create(party: Party): Party {
		this.#database
			.prepare(
				`INSERT INTO parties
				 (id, tenant_id, name, kind, email, phone, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				party.id,
				party.tenantId,
				party.name,
				party.kind,
				party.email,
				party.phone,
				party.status,
				party.createdAt,
			);
		return party;
	}
}
