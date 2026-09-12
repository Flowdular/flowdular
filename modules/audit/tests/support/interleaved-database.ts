import type {
	DatabaseHandle,
	DatabaseStatement,
	DatabaseTransaction,
} from '@flowdular/database';

/**
 * A database handle that really interleaves two transactions.
 *
 * The embedded PostgreSQL a module suite runs on is one connection behind a
 * queue, so two overlapping appends are serialized before they reach the
 * engine and a race a deployment would hit cannot be reproduced against it.
 * This handle holds exactly the four statements `appendAuditEvent` issues, runs
 * every transaction concurrently, and enforces the one constraint the race
 * breaks: `UNIQUE (tenant_id, sequence)` on audit_events. Honouring
 * `pg_advisory_xact_lock` is what makes two concurrent appends take different
 * sequences; without it both read the same newest sequence and the second
 * insert is refused, which is the liveness failure a deployment sees.
 */
export interface InterleavedAuditDatabase {
	readonly handle: DatabaseHandle;
	/** Sequences accepted, in insert order. */
	readonly sequences: readonly number[];
}

interface StoredRow {
	readonly tenantId: string;
	readonly sequence: number;
	readonly eventHash: string;
}

export function createInterleavedAuditDatabase(): InterleavedAuditDatabase {
	const events: StoredRow[] = [];
	const sequences: number[] = [];
	const subjectKeys = new Map<string, { id: string; material: string }>();
	/**
	 * One first-in queue per lock key, held for the life of a transaction
	 * exactly as `pg_advisory_xact_lock` is: a waiter is handed the lock only
	 * once the holder before it released.
	 */
	const tails = new Map<string, Promise<void>>();
	const acquire = (key: string): Promise<() => void> => {
		let release!: () => void;
		const held = new Promise<void>((settle) => {
			release = settle;
		});
		const previous = tails.get(key) ?? Promise.resolve();
		tails.set(
			key,
			previous.then(() => held),
		);
		return previous.then(() => release);
	};

	const latest = (tenantId: string): StoredRow | undefined =>
		events
			.filter((row) => row.tenantId === tenantId)
			.reduce<
				StoredRow | undefined
			>((newest, row) => (newest === undefined || row.sequence > newest.sequence ? row : newest), undefined);

	const run = async <Result>(
		body: (transaction: DatabaseTransaction) => Promise<Result>,
	): Promise<Result> => {
		const released: (() => void)[] = [];
		const transaction = {
			async query<Row>(statement: DatabaseStatement) {
				const answer = await execute(statement);
				return { rows: answer as Row[], rowCount: answer.length };
			},
			async execute(statement: DatabaseStatement) {
				const answer = await execute(statement);
				return { affectedRows: answer.length };
			},
		} as unknown as DatabaseTransaction;

		async function execute(
			statement: DatabaseStatement,
		): Promise<Record<string, unknown>[]> {
			const text = statement.text;
			const parameters = (statement.parameters ?? []) as string[];
			if (text.includes('pg_advisory_xact_lock')) {
				released.push(await acquire(String(parameters[0])));
				return [];
			}
			if (text.includes('FROM audit_events')) {
				const newest = latest(String(parameters[0]));
				return newest
					? [{ sequence: newest.sequence, event_hash: newest.eventHash }]
					: [];
			}
			if (text.startsWith('SELECT') && text.includes('audit_subject_keys')) {
				const found = subjectKeys.get(`${parameters[0]}:${parameters[1]}`);
				return found ? [{ ...found, tenant_id: parameters[0] }] : [];
			}
			if (text.includes('INSERT INTO audit_subject_keys')) {
				const key = `${parameters[1]}:${parameters[2]}`;
				if (!subjectKeys.has(key)) {
					subjectKeys.set(key, {
						id: String(parameters[0]),
						material: String(parameters[4]),
					});
				}
				return [];
			}
			if (text.includes('INSERT INTO audit_events')) {
				const tenantId = String(parameters[1]);
				const sequence = Number(parameters[2]);
				if (
					events.some(
						(row) => row.tenantId === tenantId && row.sequence === sequence,
					)
				) {
					throw new Error(
						`duplicate key value violates unique constraint "audit_events_tenant_id_sequence_key" (${tenantId}, ${sequence})`,
					);
				}
				events.push({
					tenantId,
					sequence,
					eventHash: String(parameters[10]),
				});
				sequences.push(sequence);
				return [];
			}
			throw new Error(
				`The interleaved database saw no statement like: ${text}`,
			);
		}

		try {
			return await body(transaction);
		} finally {
			for (const release of released) release();
		}
	};

	const handle = {
		transaction: (
			body: (transaction: DatabaseTransaction) => Promise<unknown>,
		) => run(body),
	} as unknown as DatabaseHandle;

	return { handle, sequences };
}
