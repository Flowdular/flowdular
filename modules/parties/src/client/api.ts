import type { CreatePartyInput, Party } from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? 'The party operation failed.');
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
