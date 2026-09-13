import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ListDirection, ListPosition } from '../src/domain/types.ts';
import {
	openDirectoryTestDatabase,
	type DirectoryTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-a';
const OTHER = 'tenant-b';

let database: DirectoryTestDatabase;

beforeAll(async () => {
	database = await openDirectoryTestDatabase();
});

afterAll(async () => {
	await database.dispose();
});

beforeEach(async () => {
	await database.reset();
});

async function seedTokens(tenantId: string, labels: readonly string[]) {
	for (const [index, label] of labels.entries()) {
		await database.repository.insertToken({
			id: `${tenantId}-token-${index}`,
			tenantId,
			label,
			tokenFingerprint: `${tenantId}-fingerprint-${index}`,
			tokenHash: `hash-${index}`,
			status: index % 2 === 0 ? 'active' : 'revoked',
			createdBy: 'owner',
			createdAt: 1_000 + index,
			lastUsedAt: null,
			expiresAt: null,
			revokedAt: null,
		});
	}
}

async function seedGroups(
	tenantId: string,
	groups: readonly [name: string, precedence: number][],
) {
	for (const [index, [displayName, precedence]] of groups.entries()) {
		await database.repository.insertGroup({
			id: `${tenantId}-group-${index}`,
			tenantId,
			externalId: null,
			displayName,
			roleKey: null,
			precedence,
			createdAt: 1_000 + index,
			updatedAt: 1_000 + index,
		});
	}
}

/** The whole set in the order the screen promises, read in one statement. */
async function ordered(
	table: string,
	sortExpression: string,
	direction: ListDirection,
): Promise<readonly string[]> {
	const order = direction === 'desc' ? 'DESC' : 'ASC';
	const result = await database.runtime.transaction(
		(transaction) =>
			transaction.query<{ id: string }>({
				text: `SELECT id FROM ${table} WHERE tenant_id = $1
				 ORDER BY ${sortExpression} ${order}, id ${order}`,
				parameters: [TENANT],
			}),
		{ access: 'read', tenantId: TENANT },
	);
	return result.rows.map((row) => row.id);
}

async function walk(
	read: (after: ListPosition | undefined) => Promise<{
		readonly items: readonly { readonly id: string }[];
		readonly next: ListPosition | null;
	}>,
): Promise<{ readonly ids: string[]; readonly pages: number }> {
	const ids: string[] = [];
	let after: ListPosition | undefined;
	let pages = 0;
	for (;;) {
		const page = await read(after);
		ids.push(...page.items.map((item) => item.id));
		pages += 1;
		if (page.next === null) return { ids, pages };
		after = page.next;
	}
}

describe('DIRECTORY-SCREEN-PAGING repository', () => {
	const LABELS = [
		'delta',
		'Alpha',
		'charlie',
		'Bravo',
		'echo',
		'Foxtrot',
		'golf',
	];

	it('walks the tokens by case-folded label in both directions as the whole set orders', async () => {
		await seedTokens(TENANT, LABELS);
		await seedTokens(OTHER, ['Alpha', 'zulu']);
		for (const direction of ['asc', 'desc'] as const) {
			const walked = await walk((after) =>
				database.repository.listTokenPage(TENANT, {
					sort: 'label',
					direction,
					limit: 3,
					after,
				}),
			);
			expect(walked.pages).toBe(3);
			expect(walked.ids).toEqual(
				await ordered('directory_scim_tokens', 'lower(label)', direction),
			);
			expect(walked.ids).toHaveLength(LABELS.length);
		}
		/* A page that ends exactly on the last row still hands out a position;
		   the page after it is empty and closes the walk. */
		const exact = await database.repository.listTokenPage(TENANT, {
			sort: 'label',
			direction: 'asc',
			limit: LABELS.length,
		});
		expect(exact.next).not.toBeNull();
		const beyond = await database.repository.listTokenPage(TENANT, {
			sort: 'label',
			direction: 'asc',
			limit: LABELS.length,
			after: exact.next!,
		});
		expect(beyond).toEqual({ items: [], next: null });
	});

	it('narrows tokens by status and label substring before it cuts the page', async () => {
		await seedTokens(TENANT, LABELS);
		const active = await database.repository.listTokenPage(TENANT, {
			status: 'active',
			sort: 'label',
			direction: 'asc',
			limit: 10,
		});
		expect(active.items.map((token) => token.label)).toEqual([
			'charlie',
			'delta',
			'echo',
			'golf',
		]);
		const searched = await database.repository.listTokenPage(TENANT, {
			search: 'L',
			sort: 'label',
			direction: 'asc',
			limit: 2,
		});
		expect(searched.items.map((token) => token.label)).toEqual([
			'Alpha',
			'charlie',
		]);
		const rest = await database.repository.listTokenPage(TENANT, {
			search: 'L',
			sort: 'label',
			direction: 'asc',
			limit: 2,
			after: searched.next!,
		});
		expect(rest.items.map((token) => token.label)).toEqual(['delta', 'golf']);
		expect(
			(
				await database.repository.listTokenPage(TENANT, {
					search: '_',
					sort: 'label',
					direction: 'asc',
					limit: 10,
				})
			).items,
		).toEqual([]);
	});

	it('walks the groups by precedence then id, and by case-folded name, as the whole set orders', async () => {
		await seedGroups(TENANT, [
			['Delta', 20],
			['alpha', 10],
			['Charlie', 20],
			['bravo', 30],
			['Echo', 5],
			['foxtrot', 20],
			['Golf', 10],
		]);
		await seedGroups(OTHER, [['alpha', 1]]);
		for (const direction of ['asc', 'desc'] as const) {
			const byPrecedence = await walk((after) =>
				database.repository.listGroupPage(TENANT, {
					sort: 'precedence',
					direction,
					limit: 3,
					after,
				}),
			);
			expect(byPrecedence.pages).toBe(3);
			expect(byPrecedence.ids).toEqual(
				await ordered('directory_scim_groups', 'precedence', direction),
			);
			const byName = await walk((after) =>
				database.repository.listGroupPage(TENANT, {
					sort: 'displayName',
					direction,
					limit: 2,
					after,
				}),
			);
			expect(byName.pages).toBe(4);
			expect(byName.ids).toEqual(
				await ordered(
					'directory_scim_groups',
					'lower(display_name)',
					direction,
				),
			);
		}
		const searched = await database.repository.listGroupPage(TENANT, {
			search: 'O',
			sort: 'displayName',
			direction: 'asc',
			limit: 10,
		});
		expect(searched.items.map((group) => group.displayName)).toEqual([
			'bravo',
			'Echo',
			'foxtrot',
			'Golf',
		]);
		expect(searched.next).toBeNull();
	});
});
