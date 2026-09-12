import type {
	ImportPort,
	ImportValidation,
	ImportWriteOutcome,
} from '../../src/domain/ports.ts';
import { TARGET_PERMISSION } from './harness.ts';

export interface FakeRecord {
	readonly email: string;
	readonly displayName: string;
	readonly role: string;
}

export interface FakePortCall {
	readonly kind: 'validate' | 'write';
	readonly rows: number;
	readonly mode?: string;
	readonly principalAccountId: string;
}

/**
 * A target module as import.core sees one: it owns its records, enforces its
 * own natural key, and answers per row. Nothing about the import machinery is
 * faked, only the module behind the port.
 */
export interface FakeImportPort {
	readonly port: ImportPort;
	/** Records per tenant, keyed by the natural key, so a repeat is observable. */
	readonly records: Map<string, Map<string, FakeRecord>>;
	/** Every call the port received, so batching is observable. */
	readonly calls: FakePortCall[];
	reset(): void;
}

export interface FakePortOptions {
	/** Rows the port itself rejects, by row number. */
	readonly rejectRows?: ReadonlySet<number>;
	/** Makes every call throw, to exercise the isolation contract. */
	readonly throws?: boolean;
	/** Answers nothing for these rows, to exercise the silent-port contract. */
	readonly silentRows?: ReadonlySet<number>;
}

export function createFakeImportPort(
	options: FakePortOptions = {},
): FakeImportPort {
	const records = new Map<string, Map<string, FakeRecord>>();
	const calls: FakePortCall[] = [];
	const tenantRecords = (tenantId: string) => {
		const existing = records.get(tenantId);
		if (existing) return existing;
		const created = new Map<string, FakeRecord>();
		records.set(tenantId, created);
		return created;
	};

	const port: ImportPort = {
		key: 'members',
		label: 'Members',
		permission: TARGET_PERMISSION,
		fields: [
			{ id: 'email', label: 'E-mail', required: true, type: 'email' },
			{ id: 'displayName', label: 'Name', required: true, type: 'string' },
			{ id: 'role', label: 'Role', required: false, type: 'string' },
		],
		naturalKey: ['email'],
		async validate(input) {
			calls.push({
				kind: 'validate',
				rows: input.rows.length,
				principalAccountId: input.principal.accountId,
			});
			if (options.throws) throw new Error('the port is broken');
			const verdicts: ImportValidation[] = [];
			for (const row of input.rows) {
				if (options.rejectRows?.has(row.row)) {
					verdicts.push({
						row: row.row,
						verdict: 'invalid',
						field: 'email',
						reason: 'REJECTED_BY_PORT',
					});
				}
			}
			return verdicts;
		},
		async write(input) {
			calls.push({
				kind: 'write',
				rows: input.rows.length,
				mode: input.mode,
				principalAccountId: input.principal.accountId,
			});
			if (options.throws) throw new Error('the port is broken');
			const held = tenantRecords(input.tenantId);
			const outcomes: ImportWriteOutcome[] = [];
			for (const row of input.rows) {
				if (options.silentRows?.has(row.row)) continue;
				const key = (row.values['email'] ?? '').toLowerCase();
				const existing = held.get(key);
				const record: FakeRecord = {
					email: row.values['email'] ?? '',
					displayName: row.values['displayName'] ?? '',
					role: row.values['role'] ?? 'member',
				};
				if (!existing) {
					held.set(key, record);
					outcomes.push({ row: row.row, outcome: 'created', recordRef: key });
					continue;
				}
				if (input.mode === 'skip-existing') {
					outcomes.push({ row: row.row, outcome: 'skipped', recordRef: key });
					continue;
				}
				if (input.mode === 'update-existing') {
					held.set(key, record);
					outcomes.push({ row: row.row, outcome: 'updated', recordRef: key });
					continue;
				}
				outcomes.push({
					row: row.row,
					outcome: 'failed',
					reason: 'ALREADY_EXISTS',
				});
			}
			return outcomes;
		},
	};

	return {
		port,
		records,
		calls,
		reset() {
			records.clear();
			calls.length = 0;
		},
	};
}

export const MEMBERS_TARGET = 'users.core.members';

export const MEMBERS_MAPPING = {
	email: 'E-mail',
	displayName: 'Name',
	role: 'Role',
} as const;

/** Five rows, the fourth missing its required name. */
export const FIVE_ROW_CSV = [
	'E-mail,Name,Role',
	'ada@example.com,Ada Lovelace,owner',
	'grace@example.com,Grace Hopper,member',
	'alan@example.com,Alan Turing,member',
	'katherine@example.com,,member',
	'edsger@example.com,Edsger Dijkstra,member',
].join('\n');
