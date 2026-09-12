import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '../src/domain/types.ts';
import { approvalsListing } from '../src/client/state.ts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';

const request = {
	id: 'request-1',
	tenantId: 'tenant-a',
	subjectModule: 'catalog.core',
	subjectRef: 'product-4711',
	permission: 'catalog.products.manage',
	action: 'publish',
	title: 'Publish product 4711',
	summary: null,
	requesterAccountId: 'account-requester',
	requirement: {
		roleKey: 'owner',
		scope: null,
		decisions: 1,
		expiresInDays: 7,
	},
	decisionsNeeded: 1,
	status: 'pending',
	expiresAt: 2_000,
	resolvedAt: null,
	createdAt: 1_000,
} satisfies ApprovalRequest;

describe('approvals inbox screen state', () => {
	it('reports the error state after a failed load instead of an empty inbox', () => {
		expect(approvalsListing([], 'decidable', '', 'error').screen).toBe('error');
		/* The rows a failed refresh left behind answer for the scope that was
		   asked for before it, so they are not what the member is shown. */
		expect(approvalsListing([request], 'mine', '', 'error').screen).toBe(
			'error',
		);
	});

	it('reports the denied state a 403 leaves and the table for every other state', () => {
		expect(approvalsListing([], 'decidable', '', 'denied').screen).toBe(
			'denied',
		);
		for (const status of ['idle', 'loading', 'submitting'] as const) {
			expect([
				status,
				approvalsListing([], 'decidable', '', status).screen,
			]).toEqual([status, 'table']);
		}
	});

	it('keeps reporting what the table says about an empty result', () => {
		expect(approvalsListing([request], 'decidable', '')).toMatchObject({
			visible: [request],
			filtered: false,
			activeFilters: 0,
		});
		expect(approvalsListing([], 'all', 'pending')).toMatchObject({
			filtered: true,
			activeFilters: 2,
		});
	});

	it('ships the error state copy in every locale', () => {
		for (const bundle of [translationsEn, translationsPl]) {
			for (const key of ['inbox.error.title', 'inbox.error.hint']) {
				expect([key, key in bundle]).toEqual([key, true]);
			}
		}
	});
});
