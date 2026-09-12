import type { DatabaseHandle } from '@flowdular/sdk/database';
import { integer, runDatabaseMigrations } from '@flowdular/sdk/database';
import type { Note } from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type { NoteRepository } from './repository.ts';

interface NoteRow {
	tenant_id: string;
	id: string;
	title: string;
	body: string;
	created_at: number | bigint | string;
}

/* Queries stay explicit. Note data never passes through a SQL rewriter, and
   values always use the adapter's parameter channel. */
const LIST = `SELECT tenant_id, id, title, body, created_at
			 FROM example_notes
			 WHERE tenant_id = $1
			 ORDER BY created_at DESC, id ASC`;

const CREATE = `INSERT INTO example_notes
			 (tenant_id, id, title, body, created_at)
			 VALUES ($1, $2, $3, $4, $5)`;

function fromRow(row: NoteRow): Note {
	return {
		tenantId: row.tenant_id,
		id: row.id,
		title: row.title,
		body: row.body,
		createdAt: integer(row.created_at, 'created_at', { min: 0 }),
	};
}

/** A repository over a platform-owned PostgreSQL handle. */
export class DatabaseNoteRepository implements NoteRepository {
	constructor(private readonly database: DatabaseHandle) {}

	async list(tenantId: string): Promise<readonly Note[]> {
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<NoteRow>({ text: LIST, parameters: [tenantId] }),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromRow);
	}

	async create(note: Note): Promise<Note> {
		await this.database.transaction(
			(transaction) =>
				transaction.execute({
					text: CREATE,
					parameters: [
						note.tenantId,
						note.id,
						note.title,
						note.body,
						note.createdAt,
					],
				}),
			{ access: 'write', tenantId: note.tenantId },
		);
		return note;
	}
}

export async function migrateExampleDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'example.core', databaseMigrations);
}
