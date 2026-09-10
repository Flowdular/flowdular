import type { Note } from '../domain/types.ts';

/** The database-agnostic business port. No driver type crosses it. */
export interface NoteRepository {
	list(tenantId: string): Promise<readonly Note[]>;
	create(note: Note): Promise<Note>;
}
