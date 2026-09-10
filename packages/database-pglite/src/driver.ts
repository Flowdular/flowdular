import type {
	PostgresDriverClient,
	PostgresDriverPool,
	PostgresDriverQuery,
	PostgresDriverResult,
} from '@flowdular/database';
import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';

export interface PgliteDriverPoolOptions {
	/** Omit for an in-memory database. A path keeps the data across restarts. */
	readonly dataDirectory?: string | undefined;
	/** Statements the database runs once, before the first lease. */
	readonly bootstrap?: string | undefined;
	/**
	 * Role every lease of this pool enters. A deployment separates the schema
	 * owner from the runtime role by connection; one embedded connection reaches
	 * the same enforcement by entering the role for the life of the lease.
	 */
	readonly role?: string | undefined;
}

export interface PgliteCluster {
	/** One pool per role over the same embedded database. */
	pool(role?: string): PostgresDriverPool;
	close(): Promise<void>;
}

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;

/* node-postgres returns int8 as a string so a value beyond Number.MAX_SAFE_INTEGER
   survives the trip, and every repository normalizes on the way in. PGlite parses
   it to a number by default, which would let a missing normalizer pass every test
   and then fail against a server. Matching the server driver here is what makes
   the embedded build a real rehearsal. */
const INT8_OID = 20;
const SERVER_PARSERS = Object.freeze({ [INT8_OID]: (value: string) => value });

/* PGlite is one embedded connection, so two overlapping transactions would
   interleave their BEGIN and COMMIT on the same session. Leases are handed out
   one at a time and the queue preserves arrival order. */
class ConnectionQueue {
	#tail: Promise<void> = Promise.resolve();

	acquire(): Promise<() => void> {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waited = this.#tail.then(() => release);
		this.#tail = this.#tail.then(() => held);
		return waited;
	}
}

/* PGlite reports affectedRows as 0 for a row-returning statement, while the
   adapter reads rowCount first. Returning the driver value unchanged would make
   every schema probe answer "absent". */
function result(rows: unknown[], affected: number): PostgresDriverResult {
	return {
		rows: rows as readonly Record<string, unknown>[],
		rowCount: rows.length > 0 ? rows.length : affected,
	};
}

/**
 * Runs the PostgreSQL adapter against an embedded PostgreSQL build. It speaks
 * the same SQL, enforces the same row-level security, and needs no server, so a
 * local run and a module suite exercise the production dialect.
 */
export function createPgliteCluster(
	options: PgliteDriverPoolOptions = {},
): PgliteCluster {
	const queue = new ConnectionQueue();
	let databasePromise: Promise<PGlite> | undefined;
	let closePromise: Promise<void> | undefined;
	/* Every pool shares one embedded database, and each adapter ends its own
	   pool on disposal. The database closes when the last of them is done. */
	let issued = 0;
	let ended = 0;

	const close = (): Promise<void> => {
		closePromise ??= (async () => {
			if (!databasePromise) return;
			// A failed initialization has no database to close; its caller already
			// received the original error. Do not replace it during disposal.
			const instance = await databasePromise.catch(() => undefined);
			databasePromise = undefined;
			await instance?.close();
		})();
		return closePromise;
	};

	const database = async (): Promise<PGlite> => {
		databasePromise ??= (async () => {
			if (options.dataDirectory) {
				await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
			}
			const created = options.dataDirectory
				? await PGlite.create({
						dataDir: options.dataDirectory,
						parsers: SERVER_PARSERS,
					})
				: await PGlite.create({ parsers: SERVER_PARSERS });
			try {
				if (options.bootstrap) await created.exec(options.bootstrap);
			} catch (error) {
				try {
					await created.close();
				} catch (closeError) {
					throw new AggregateError(
						[error, closeError],
						'PGlite bootstrap failed and cleanup also failed.',
					);
				}
				throw error;
			}
			return created;
		})();
		return databasePromise;
	};

	const pool = (role?: string): PostgresDriverPool => {
		if (role !== undefined && !ROLE.test(role)) {
			throw new Error(`"${role}" is not a usable PostgreSQL role name.`);
		}
		issued += 1;
		return {
			cancellation: 'before-start',
			async connect(): Promise<PostgresDriverClient> {
				const release = await queue.acquire();
				let instance: PGlite;
				try {
					instance = await database();
					if (role) await instance.exec(`SET ROLE ${role}`);
				} catch (error) {
					release();
					throw error;
				}
				let released = false;
				const run = async ({
					text,
					values,
				}: PostgresDriverQuery): Promise<PostgresDriverResult> => {
					/* The extended protocol carries parameters but accepts a single
					   statement, so checked-in migration scripts run through exec(). */
					if (values === undefined || values.length === 0) {
						const answers = await instance.exec(text);
						const last = answers[answers.length - 1];
						return last
							? result(last.rows, last.affectedRows ?? 0)
							: result([], 0);
					}
					const answer = await instance.query(text, [...values]);
					return result(answer.rows, answer.affectedRows ?? 0);
				};
				return {
					query: run,
					release() {
						if (released) return;
						released = true;
						/* The session is shared, so the role must not outlive the lease. */
						const reset = role
							? instance.exec('RESET ROLE').catch(() => undefined)
							: Promise.resolve();
						void reset.finally(release);
					},
				};
			},
			async end(): Promise<void> {
				ended += 1;
				if (ended < issued) return;
				await close();
			},
		};
	};

	return { pool, close };
}

/** One pool over its own embedded database. */
export function createPgliteDriverPool(
	options: PgliteDriverPoolOptions = {},
): PostgresDriverPool {
	return createPgliteCluster(options).pool(options.role);
}
