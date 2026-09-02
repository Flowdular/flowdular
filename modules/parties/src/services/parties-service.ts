import { randomUUID } from 'node:crypto';
import {
	normalizeActor,
	type Actor,
	type HistoryPage,
	type HistoryRequest,
} from '@coreloom/kernel';
import type {
	CreatePartyInput,
	Party,
	PartyKind,
	UpdatePartyInput,
} from '../domain/types.ts';
import type { PartyRepository } from './repository.ts';
import {
	canonicalDigest,
	TargetIdempotencyConflictError,
} from './target-idempotency.ts';

export interface PartyIdempotencyRequest {
	readonly key: string;
	readonly operationId: string;
}

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

function emailAddress(value: string | null | undefined): string | null {
	const email = optional(value, 'email', 254);
	if (email && !email.includes('@')) {
		throw new PartyServiceError('INVALID_EMAIL', 'email must be valid.');
	}
	return email?.toLowerCase() ?? null;
}

function vatIdentifier(value: string | null | undefined): string | null {
	if (value === undefined || value === null || value.trim() === '') return null;
	const normalized = value.trim();
	if (normalized.length > 20 || !/^[A-Za-z0-9]+$/.test(normalized)) {
		throw new PartyServiceError(
			'INVALID_VAT_ID',
			'vatId must contain only letters and digits and be at most 20 characters.',
		);
	}
	return normalized;
}

function trustedActor(actor: Actor): Actor {
	const normalized = normalizeActor(actor);
	if (!normalized) {
		throw new PartyServiceError(
			'INVALID_ACTOR',
			'actor must carry a kind, an id, and a label.',
		);
	}
	return normalized;
}

export class PartiesService {
	constructor(private readonly repository: PartyRepository) {}

	list(tenantId: string): readonly Party[] {
		return this.repository.list(bounded(tenantId, 'tenantId', 1, 128));
	}

	get(tenantId: string, id: string): Party | null {
		const trustedId = bounded(id, 'id', 1, 128);
		return this.list(tenantId).find((party) => party.id === trustedId) ?? null;
	}

	create(tenantId: string, input: CreatePartyInput, actor: Actor): Party {
		return this.repository.create(
			this.newParty(tenantId, input),
			trustedActor(actor),
		);
	}

	createIdempotent(
		tenantId: string,
		input: CreatePartyInput,
		actor: Actor,
		idempotency: PartyIdempotencyRequest,
	): Party {
		const party = this.newParty(tenantId, input);
		try {
			return this.repository.createIdempotent(party, trustedActor(actor), {
				key: bounded(idempotency.key, 'idempotencyKey', 8, 128),
				operationId: bounded(idempotency.operationId, 'operationId', 3, 160),
				inputDigest: canonicalDigest({
					name: party.name,
					kind: party.kind,
					email: party.email,
					phone: party.phone,
					vatId: party.vatId,
				}),
			});
		} catch (error) {
			if (error instanceof TargetIdempotencyConflictError) {
				throw new PartyServiceError(error.code, error.message, 409);
			}
			throw error;
		}
	}

	update(tenantId: string, input: UpdatePartyInput, actor: Actor): Party {
		const party = this.repository.update(
			bounded(tenantId, 'tenantId', 1, 128),
			{
				id: bounded(input.id, 'id', 1, 128),
				name: bounded(input.name, 'name', 2, 160),
				kind: partyKind(input.kind),
				email: emailAddress(input.email),
				phone: optional(input.phone, 'phone', 40),
				vatId: vatIdentifier(input.vatId),
			},
			trustedActor(actor),
		);
		if (!party) {
			throw new PartyServiceError(
				'PARTY_NOT_FOUND',
				'The party was not found in the active tenant.',
				404,
			);
		}
		return party;
	}

	archive(tenantId: string, id: string, actor: Actor): Party {
		return this.changeStatus(tenantId, id, 'archived', actor);
	}

	restore(tenantId: string, id: string, actor: Actor): Party {
		return this.changeStatus(tenantId, id, 'active', actor);
	}

	delete(tenantId: string, id: string, actor: Actor): void {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const trustedId = bounded(id, 'id', 1, 128);
		const existing = this.get(trustedTenantId, trustedId);
		if (!existing) {
			throw new PartyServiceError(
				'PARTY_NOT_FOUND',
				'The party was not found in the active tenant.',
				404,
			);
		}
		if (existing.status !== 'archived') {
			throw new PartyServiceError(
				'PARTY_NOT_ARCHIVED',
				'Archive the party before deleting it permanently.',
				409,
			);
		}
		if (
			!this.repository.delete(trustedTenantId, trustedId, trustedActor(actor))
		) {
			throw new PartyServiceError(
				'PARTY_NOT_FOUND',
				'The party was not found in the active tenant.',
				404,
			);
		}
	}

	history(tenantId: string, request: HistoryRequest): HistoryPage {
		return this.repository.history({
			tenantId: bounded(tenantId, 'tenantId', 1, 128),
			recordId: bounded(request.recordId, 'recordId', 1, 128),
			limit: request.limit,
			cursor: request.cursor,
		});
	}

	private changeStatus(
		tenantId: string,
		id: string,
		status: Party['status'],
		actor: Actor,
	): Party {
		const party = this.repository.setStatus(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(id, 'id', 1, 128),
			status,
			trustedActor(actor),
		);
		if (!party) {
			throw new PartyServiceError(
				'PARTY_NOT_FOUND',
				'The party was not found in the active tenant.',
				404,
			);
		}
		return party;
	}

	private newParty(tenantId: string, input: CreatePartyInput): Party {
		return {
			id: randomUUID(),
			tenantId: bounded(tenantId, 'tenantId', 1, 128),
			name: bounded(input.name, 'name', 2, 160),
			kind: partyKind(input.kind),
			email: emailAddress(input.email),
			phone: optional(input.phone, 'phone', 40),
			vatId: vatIdentifier(input.vatId),
			status: 'active',
			createdAt: Date.now(),
		};
	}
}
