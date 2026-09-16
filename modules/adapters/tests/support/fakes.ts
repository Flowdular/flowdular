import type { AuthPrincipal } from '@flowdular/module-auth';
import { defineListExport, type DefinedListExport } from '@flowdular/server';
import { ADAPTERS_PERMISSIONS } from '../../src/acl/permissions.ts';
import type {
	ConnectorCallAnswer,
	ConnectorCaller,
	ConnectorCalls,
	ExportLists,
	ImportWriter,
	MeterRegistry,
} from '../../src/services/capabilities.ts';

export const TENANT = 'tenant-adapters';
export const OTHER_TENANT = 'tenant-other';
export const OWNER = 'account-owner';
export const PORT_PERMISSION = 'vendors.records.manage';
export const LIST_PERMISSION = 'vendors.records.read';

export function principal(
	scopes: readonly string[] = [
		ADAPTERS_PERMISSIONS.read,
		ADAPTERS_PERMISSIONS.manage,
		PORT_PERMISSION,
		LIST_PERMISSION,
	],
	tenantId = TENANT,
	accountId = OWNER,
): AuthPrincipal {
	return {
		accountId,
		tenantId,
		email: `${accountId}@example.com`,
		displayName: 'Owner',
		role: 'owner',
		scopes,
		tenants: [],
	};
}

export interface FakeVendor {
	readonly code: string;
	readonly name: string;
	readonly country?: string | undefined;
}

export interface FakeWriter {
	readonly writer: ImportWriter;
	/** Records per tenant keyed by the natural key, so a repeat is observable. */
	readonly records: Map<string, Map<string, FakeVendor>>;
	readonly writes: { rows: number; mode: string; sourceRef: string }[];
	validates: number;
}

/**
 * The vendors.core records port as import.write.v1 answers for it: a natural
 * key of `code`, a required `name`, and a port refusal for any name that says
 * REJECT. The outcome rules are the users.core members port's.
 */
export function createFakeWriter(batchSize = 50): FakeWriter {
	const records = new Map<string, Map<string, FakeVendor>>();
	const writes: FakeWriter['writes'] = [];
	const state: FakeWriter = {
		records,
		writes,
		validates: 0,
		writer: {
			describe(moduleId, portKey) {
				if (moduleId !== 'vendors.core' || portKey !== 'records') return null;
				return {
					target: 'vendors.core.records',
					moduleId,
					key: portKey,
					label: 'Vendors',
					permission: PORT_PERMISSION,
					fields: [
						{ id: 'code', label: 'Code', required: true, type: 'string' },
						{ id: 'name', label: 'Name', required: true, type: 'string' },
						{
							id: 'country',
							label: 'Country',
							required: false,
							type: 'string',
						},
					],
					naturalKey: ['code'],
					batchSize,
				};
			},
			async validate(input) {
				state.validates += 1;
				return input.rows.map((row) =>
					row.values.name === 'REJECT'
						? {
								row: row.row,
								verdict: 'invalid' as const,
								field: 'name',
								reason: 'NAME_REJECTED',
							}
						: { row: row.row, verdict: 'valid' as const },
				);
			},
			async write(input) {
				if (!input.principal.scopes.includes(PORT_PERMISSION)) {
					throw Object.assign(new Error('forbidden'), {
						code: 'TARGET_FORBIDDEN',
					});
				}
				if (input.rows.length > batchSize) {
					throw Object.assign(new Error('too many'), {
						code: 'BATCH_TOO_LARGE',
					});
				}
				writes.push({
					rows: input.rows.length,
					mode: input.mode,
					sourceRef: input.sourceRef,
				});
				const held =
					records.get(input.tenantId) ?? new Map<string, FakeVendor>();
				records.set(input.tenantId, held);
				return input.rows.map((row) => {
					if (row.values.name === 'REJECT') {
						return {
							row: row.row,
							outcome: 'invalid' as const,
							field: 'name',
							reason: 'NAME_REJECTED',
						};
					}
					const code = row.values.code!;
					const existing = held.get(code);
					held.set(code, {
						code,
						name: row.values.name!,
						country: row.values.country,
					});
					if (!existing) {
						return {
							row: row.row,
							outcome: 'created' as const,
							recordRef: code,
						};
					}
					return input.mode === 'skip-existing'
						? { row: row.row, outcome: 'skipped' as const, recordRef: code }
						: { row: row.row, outcome: 'updated' as const, recordRef: code };
				});
			},
		},
	};
	return state;
}

export interface RecordedCall {
	readonly tenantId: string;
	readonly instanceId: string;
	readonly operation: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly caller: ConnectorCaller;
	readonly callerRef: string | undefined;
	readonly idempotencyKey: string | undefined;
}

export interface FakeCalls {
	readonly calls: ConnectorCalls;
	readonly log: RecordedCall[];
	consent: boolean;
	/** Answers one call; the default answers an empty success. */
	respond: (call: RecordedCall) => Partial<ConnectorCallAnswer>;
}

export function createFakeCalls(): FakeCalls {
	const log: RecordedCall[] = [];
	const answered = new Map<
		string,
		{ readonly input: string; readonly answer: ConnectorCallAnswer }
	>();
	const state: FakeCalls = {
		log,
		consent: true,
		respond: () => ({ body: {} }),
		calls: {
			async consented(_tenantId, _instanceId, caller) {
				return caller === 'test' ? true : state.consent;
			},
			async call(request) {
				const call: RecordedCall = {
					tenantId: request.tenantId,
					instanceId: request.instanceId,
					operation: request.operation,
					input: request.input,
					caller: request.caller,
					callerRef: request.callerRef,
					idempotencyKey: request.idempotencyKey,
				};
				/* The connectors ledger: a repeated key answers the call it bound
				   without reaching the service again. */
				const bound = request.idempotencyKey
					? answered.get(request.idempotencyKey)
					: undefined;
				if (bound) {
					if (bound.input !== JSON.stringify(request.input)) {
						throw Object.assign(new Error('conflict'), {
							code: 'CALL_IDEMPOTENCY_CONFLICT',
						});
					}
					return { ...bound.answer, replayed: true, body: null };
				}
				log.push(call);
				const answer: ConnectorCallAnswer = {
					callId: `call-${log.length}`,
					outcome: 'succeeded',
					status: 200,
					errorClass: null,
					body: null,
					replayed: false,
					retryAfterMs: null,
					...state.respond(call),
				};
				if (request.idempotencyKey) {
					answered.set(request.idempotencyKey, {
						input: JSON.stringify(request.input),
						answer,
					});
				}
				return answer;
			},
		},
	};
	return state;
}

export interface FakeList {
	readonly definition: DefinedListExport;
	readonly lists: ExportLists;
	rows: { id: string; code: string; name: string; note: string }[];
	/** The process that signs the cursors; a cursor of another one is refused. */
	process: number;
	pageSize: number;
}

/** A list export of vendors.core, paged by index, as a module would declare it. */
export function createFakeList(): FakeList {
	const state: FakeList = {
		rows: [],
		process: 1,
		pageSize: 2,
		definition: defineListExport<{
			id: string;
			code: string;
			name: string;
			note: string;
		}>({
			id: 'vendors.core.records',
			label: 'Vendors',
			permission: LIST_PERMISSION,
			columns: [
				{ key: 'code', header: 'Code', value: (row) => row.code },
				{ key: 'name', header: 'Name', value: (row) => row.name },
				{ key: 'note', header: 'Note', value: (row) => row.note },
			],
			page: async (_principal, cursor, limit) => {
				/* The list answers two rows a page whatever it was asked for, as a
				   list with a smaller page of its own may, and signs its cursors
				   per process, as a list with a random cursor secret does. */
				let start = 0;
				if (cursor !== null) {
					const [signer, position] = cursor.split(':');
					if (Number(signer) !== state.process) {
						throw new Error('The cursor was signed by another process.');
					}
					start = Number(position);
				}
				const rows = state.rows.slice(
					start,
					start + Math.min(limit, state.pageSize),
				);
				const next = start + rows.length;
				return {
					rows,
					nextCursor:
						next < state.rows.length ? `${state.process}:${next}` : null,
				};
			},
		}),
		lists: {
			register: () => undefined,
			find: (id) => (id === 'vendors.core.records' ? state.definition : null),
		},
	};
	return state;
}

export interface FakeMeters {
	readonly meters: MeterRegistry;
	readonly recorded: { meter: string; amount: number; sourceRef?: string }[];
}

export function createFakeMeters(): FakeMeters {
	const recorded: FakeMeters['recorded'] = [];
	return {
		recorded,
		meters: {
			declare: () => undefined,
			async record(input) {
				recorded.push({
					meter: input.meter,
					amount: input.amount,
					...(input.sourceRef === undefined
						? {}
						: { sourceRef: input.sourceRef }),
				});
				return { recorded: true };
			},
		},
	};
}
