import type {
	CreatePartyInput,
	Party,
	UpdatePartyInput,
} from '../domain/types.ts';
import { t } from '@coreloom/client/i18n';
import type { HistoryPage } from '@coreloom/kernel';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? t('parties.error.request'));
	}
	return value;
}

export async function loadParties(): Promise<readonly Party[]> {
	const response = await fetch('/api/parties', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (await payload<{ readonly parties: readonly Party[] }>(response))
		.parties;
}

export async function createParty(
	input: CreatePartyInput,
	csrfToken: string,
): Promise<Party> {
	const response = await fetch('/api/parties', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return (await payload<{ readonly party: Party }>(response)).party;
}

export async function updateParty(
	input: UpdatePartyInput,
	csrfToken: string,
): Promise<Party> {
	const response = await fetch('/api/parties/update', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(input),
	});
	return (await payload<{ readonly party: Party }>(response)).party;
}

async function partyAction(
	action: 'archive' | 'restore',
	id: string,
	csrfToken: string,
): Promise<Party> {
	const response = await fetch('/api/parties/' + action, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify({ id }),
	});
	return (await payload<{ readonly party: Party }>(response)).party;
}

export function archiveParty(id: string, csrfToken: string): Promise<Party> {
	return partyAction('archive', id, csrfToken);
}

export function restoreParty(id: string, csrfToken: string): Promise<Party> {
	return partyAction('restore', id, csrfToken);
}

export async function deleteParty(
	id: string,
	csrfToken: string,
): Promise<void> {
	const response = await fetch('/api/parties/delete', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify({ id }),
	});
	await payload<{ readonly deleted: true }>(response);
}

export async function loadPartyHistory(recordId: string): Promise<HistoryPage> {
	const response = await fetch(
		`/api/parties/history?recordId=${encodeURIComponent(recordId)}&limit=100`,
		{
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		},
	);
	return payload<HistoryPage>(response);
}
