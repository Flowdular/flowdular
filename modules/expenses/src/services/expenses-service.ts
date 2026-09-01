import { randomUUID } from 'node:crypto';
import {
	EXPENSE_CLAIM_CATEGORIES,
	EXPENSE_CLAIM_STATUSES,
	type CreateExpensesClaimInput,
	type ExpenseClaimCategory,
	type ExpenseClaimDecision,
	type ExpenseClaimStatus,
	type ExpensesClaim,
	type UpdateExpensesClaimInput,
} from '../domain/types.ts';
import type { ExpensesRepository } from './repository.ts';

export class ExpensesServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'ExpensesServiceError';
	}
}

function bounded(
	value: string,
	field: string,
	min: number,
	max: number,
	code = 'INVALID_CLAIM_INPUT',
): string {
	const normalized = value.trim();
	if (normalized.length < min || normalized.length > max) {
		throw new ExpensesServiceError(
			code,
			`${field} must contain between ${min} and ${max} characters.`,
		);
	}
	return normalized;
}

function identifier(value: string, field: string): string {
	return bounded(value, field, 1, 128, 'INVALID_INPUT');
}

function amount(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new ExpensesServiceError(
			'INVALID_CLAIM_INPUT',
			'amountMinor must be a non-negative integer.',
		);
	}
	return value;
}

function currency(value: string): string {
	const normalized = bounded(value, 'currency', 3, 3).toUpperCase();
	if (!/^[A-Z]{3}$/.test(normalized)) {
		throw new ExpensesServiceError(
			'INVALID_CLAIM_INPUT',
			'currency must be a three-letter code.',
		);
	}
	return normalized;
}

function category(value: ExpenseClaimCategory): ExpenseClaimCategory {
	if (!(EXPENSE_CLAIM_CATEGORIES as readonly string[]).includes(value)) {
		throw new ExpensesServiceError(
			'INVALID_CLAIM_INPUT',
			'category must be travel, meals, equipment, or other.',
		);
	}
	return value;
}

function expenseDate(value: string): string {
	const normalized = bounded(value, 'expenseDate', 10, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
		throw new ExpensesServiceError(
			'INVALID_CLAIM_INPUT',
			'expenseDate must use YYYY-MM-DD.',
		);
	}
	const parsed = new Date(`${normalized}T00:00:00.000Z`);
	if (
		Number.isNaN(parsed.getTime()) ||
		parsed.toISOString().slice(0, 10) !== normalized
	) {
		throw new ExpensesServiceError(
			'INVALID_CLAIM_INPUT',
			'expenseDate must be a valid calendar date.',
		);
	}
	return normalized;
}

function optionalNote(value: string | null): string | null {
	return value === null ? null : bounded(value, 'note', 1, 2_000);
}

function draftInput(
	input: CreateExpensesClaimInput | UpdateExpensesClaimInput,
): CreateExpensesClaimInput {
	return {
		title: bounded(input.title, 'title', 1, 160),
		amountMinor: amount(input.amountMinor),
		currency: currency(input.currency),
		category: category(input.category),
		expenseDate: expenseDate(input.expenseDate),
		note: optionalNote(input.note),
	};
}

export class ExpensesService {
	constructor(private readonly repository: ExpensesRepository) {}

	list(
		tenantId: string,
		claimantId: string,
		status: ExpenseClaimStatus | null,
		includeApprovalQueue: boolean,
	): readonly ExpensesClaim[] {
		if (
			status !== null &&
			!(EXPENSE_CLAIM_STATUSES as readonly string[]).includes(status)
		) {
			throw new ExpensesServiceError(
				'INVALID_CLAIM_STATUS',
				'status must be draft, submitted, approved, or rejected.',
			);
		}
		return this.repository.list({
			tenantId: identifier(tenantId, 'tenantId'),
			claimantId: identifier(claimantId, 'claimantId'),
			status,
			includeApprovalQueue,
		});
	}

	create(
		tenantId: string,
		claimantId: string,
		input: CreateExpensesClaimInput,
	): ExpensesClaim {
		const normalized = draftInput(input);
		return this.repository.create({
			id: randomUUID(),
			tenantId: identifier(tenantId, 'tenantId'),
			claimantId: identifier(claimantId, 'claimantId'),
			...normalized,
			name: normalized.title,
			status: 'draft',
			decisionComment: null,
			createdAt: Date.now(),
		});
	}

	update(
		tenantId: string,
		claimantId: string,
		claimId: string,
		input: UpdateExpensesClaimInput,
	): ExpensesClaim {
		const current = this.ownedDraft(tenantId, claimantId, claimId);
		const normalized = draftInput(input);
		return this.repository.update({
			...current,
			...normalized,
			name: normalized.title,
		});
	}

	submit(tenantId: string, claimantId: string, claimId: string): ExpensesClaim {
		const current = this.ownedDraft(tenantId, claimantId, claimId);
		return this.repository.update({ ...current, status: 'submitted' });
	}

	decide(
		tenantId: string,
		claimId: string,
		decision: ExpenseClaimDecision,
		comment: string,
	): ExpensesClaim {
		const current = this.claim(tenantId, claimId);
		if (current.status !== 'submitted') {
			throw new ExpensesServiceError(
				'CLAIM_NOT_SUBMITTED',
				'Only a submitted claim can be approved or rejected.',
				409,
			);
		}
		return this.repository.update({
			...current,
			status: decision,
			decisionComment: bounded(
				comment,
				'decisionComment',
				1,
				2_000,
				'INVALID_DECISION_COMMENT',
			),
		});
	}

	countAwaitingApproval(tenantId: string): number {
		return this.repository.countAwaitingApproval(
			identifier(tenantId, 'tenantId'),
		);
	}

	private claim(tenantId: string, claimId: string): ExpensesClaim {
		const record = this.repository.find(
			identifier(tenantId, 'tenantId'),
			identifier(claimId, 'claimId'),
		);
		if (!record) {
			throw new ExpensesServiceError(
				'CLAIM_NOT_FOUND',
				'The expense claim was not found.',
				404,
			);
		}
		return record;
	}

	private ownedDraft(
		tenantId: string,
		claimantId: string,
		claimId: string,
	): ExpensesClaim {
		const record = this.claim(tenantId, claimId);
		if (record.claimantId !== identifier(claimantId, 'claimantId')) {
			throw new ExpensesServiceError(
				'CLAIM_NOT_OWNED',
				'Only the claimant can change or submit this claim.',
				403,
			);
		}
		if (record.status !== 'draft') {
			throw new ExpensesServiceError(
				'CLAIM_NOT_DRAFT',
				'Only a draft claim can be changed or submitted.',
				409,
			);
		}
		return record;
	}
}
