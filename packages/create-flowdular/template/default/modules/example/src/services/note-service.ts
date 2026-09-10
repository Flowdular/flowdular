import { randomUUID } from 'node:crypto';
import type { CreateNoteInput, Note } from '../domain/types.ts';
import type { NoteRepository } from './repository.ts';

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export class NoteServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'NoteServiceError';
	}
}

function text(value: string, field: string, max: number): string {
	if (typeof value !== 'string' || CONTROL_CHARACTER_PATTERN.test(value)) {
		throw new NoteServiceError(
			'INVALID_INPUT',
			`${field} must not contain control characters.`,
		);
	}
	const normalized = value.trim();
	if (normalized.length < 1 || normalized.length > max) {
		throw new NoteServiceError(
			'INVALID_INPUT',
			`${field} must contain between 1 and ${String(max)} characters.`,
		);
	}
	return normalized;
}

export class NoteService {
	constructor(
		private readonly repository: NoteRepository,
		private readonly now: () => number = () => Date.now(),
	) {}

	list(tenantId: string): Promise<readonly Note[]> {
		return this.repository.list(tenantId);
	}

	create(tenantId: string, input: CreateNoteInput): Promise<Note> {
		return this.repository.create({
			tenantId,
			id: randomUUID(),
			title: text(input.title, 'title', 120),
			body: text(input.body, 'body', 4_000),
			createdAt: this.now(),
		});
	}
}
