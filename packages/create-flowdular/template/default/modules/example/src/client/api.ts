import { t } from '@flowdular/sdk/client/i18n';
import type { CreateNoteInput, Note } from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? t('example.error.request'));
	}
	return value;
}

export async function loadNotes(): Promise<readonly Note[]> {
	const response = await fetch('/api/example/notes', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (await payload<{ readonly notes: readonly Note[] }>(response)).notes;
}

export async function createNote(
	input: CreateNoteInput,
	csrfToken: string,
): Promise<Note> {
	const response = await fetch('/api/example/notes', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return (await payload<{ readonly note: Note }>(response)).note;
}
