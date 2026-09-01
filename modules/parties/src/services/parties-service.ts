import { randomUUID } from 'node:crypto';
import type { CreatePartyInput, Party, PartyKind } from '../domain/types.ts';
import type { PartyRepository } from './repository.ts';

export class PartyServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'PartyServiceError';
	}
}

function bounded(
	value: string,
	field: string,
	min: number,
	max: number,
): string {
	const normalized = value.trim();
	if (normalized.length < min || normalized.length > max) {
		throw new PartyServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${min} and ${max} characters.`,
		);
	}
	return normalized;
}

function optional(
	value: string | null | undefined,
	field: string,
	max: number,
) {
	if (value === undefined || value === null || value.trim() === '') return null;
	return bounded(value, field, 1, max);
}

function partyKind(value: PartyKind): PartyKind {
	if (value !== 'customer' && value !== 'supplier' && value !== 'both') {
		throw new PartyServiceError(
			'INVALID_PARTY_KIND',
			'kind must be customer, supplier, or both.',
		);
	}
	return value;
}

export class PartiesService {
	constructor(private readonly repository: PartyRepository) {}

	list(tenantId: string): readonly Party[] {
		return this.repository.list(bounded(tenantId, 'tenantId', 1, 128));
	}

	create(tenantId: string, input: CreatePartyInput): Party {
		const email = optional(input.email, 'email', 254);
		if (email && !email.includes('@')) {
			throw new PartyServiceError('INVALID_EMAIL', 'email must be valid.');
		}
		return this.repository.create({
			id: randomUUID(),
			tenantId: bounded(tenantId, 'tenantId', 1, 128),
			name: bounded(input.name, 'name', 2, 160),
			kind: partyKind(input.kind),
			email: email?.toLowerCase() ?? null,
			phone: optional(input.phone, 'phone', 40),
			status: 'active',
			createdAt: Date.now(),
		});
	}
}
