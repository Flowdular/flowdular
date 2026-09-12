import {
	defineListExport,
	type DefinedListExport,
	type ListExportPrincipal,
} from '@flowdular/server';
import { LIST_PERMISSION } from './harness.ts';

export const MEMBERS_LIST = 'users.core.members';

export interface FakeMember {
	readonly email: string;
	readonly displayName: string;
	readonly joinedAt: Date;
}

export interface FakeListCall {
	readonly principal: ListExportPrincipal;
	readonly cursor: string | null;
	readonly limit: number;
}

export interface FakeList {
	readonly definition: DefinedListExport;
	/** Rows per workspace, so a tenant leak through the snapshot is observable. */
	readonly rows: Map<string, FakeMember[]>;
	/** Every page call, so the walk and the principal are observable. */
	readonly calls: FakeListCall[];
	reset(): void;
}

export function members(count: number, from = 0): FakeMember[] {
	return Array.from({ length: count }, (_value, index) => {
		const number = from + index + 1;
		return {
			email: `member-${number}@example.com`,
			displayName: `Member ${number}`,
			joinedAt: new Date(Date.UTC(2026, 0, 1 + (number % 28))),
		};
	});
}

export interface FakeListOptions {
	readonly id?: string;
	readonly permission?: string;
	/** Makes every page call throw, to exercise the isolation contract. */
	readonly throws?: boolean;
	/** Answers the cursor it was given, to exercise the stall refusal. */
	readonly stalls?: boolean;
	/** Characters in the display name, to reach the byte bound quickly. */
	readonly padding?: number;
}

/**
 * A list that pages its rows by offset the way a keyset list pages by keyset:
 * one page per call, a cursor that advances, and null on the last page.
 */
export function createFakeList(options: FakeListOptions = {}): FakeList {
	const rows = new Map<string, FakeMember[]>();
	const calls: FakeListCall[] = [];
	const padding = options.padding ?? 0;
	const definition = defineListExport<FakeMember>({
		id: options.id ?? MEMBERS_LIST,
		label: 'Members',
		permission: options.permission ?? LIST_PERMISSION,
		columns: [
			{ key: 'email', header: 'E-mail', value: (row) => row.email },
			{
				key: 'displayName',
				header: 'Name',
				value: (row) =>
					padding === 0
						? row.displayName
						: row.displayName + ' '.repeat(padding),
			},
			{ key: 'joinedAt', header: 'Joined', value: (row) => row.joinedAt },
		],
		page: async (principal, cursor, limit) => {
			calls.push({ principal, cursor, limit });
			if (options.throws) throw new Error('the list exploded');
			const source = rows.get(principal.tenantId) ?? [];
			/* Answers the same cursor on every call after the first, which is the
			   one way a keyset walk could never end. */
			if (options.stalls) {
				return { rows: source.slice(0, limit), nextCursor: 'stuck' };
			}
			const offset = cursor === null ? 0 : Number(cursor);
			const slice = source.slice(offset, offset + limit);
			const next = offset + slice.length;
			return {
				rows: slice,
				nextCursor: next < source.length ? String(next) : null,
			};
		},
	});
	return {
		definition,
		rows,
		calls,
		reset() {
			rows.clear();
			calls.length = 0;
		},
	};
}
