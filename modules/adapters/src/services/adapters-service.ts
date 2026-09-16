import { createHash, randomUUID } from 'node:crypto';
import type { AuthPrincipal } from '@flowdular/module-auth';
import { ADAPTERS_PERMISSIONS } from '../acl/permissions.ts';
import { nextCronSlot, parseCron } from '../domain/cron.ts';
import {
	AdapterMappingError,
	applyMapping,
	assertMappingTarget,
	readMapping,
	type MappingTarget,
} from '../domain/mapping.ts';
import { readPath, writePath } from '../domain/paths.ts';
import { recordedAnswer } from '../domain/recorded.ts';
import type {
	AdapterJson,
	AdapterJsonObject,
	AdapterMappingRule,
	AdapterRegistration,
} from '../domain/registry.ts';
import {
	ADAPTER_LIMITS,
	ADAPTERS_MODULE_ID,
	type AdapterAuditAction,
	type AdapterAuditEvent,
	type AdapterBinding,
	type AdapterDueBinding,
	type AdapterRun,
	type AdapterRunRow,
	type AdapterRunTrigger,
} from '../domain/types.ts';
import type {
	ConnectorCallAnswer,
	ConnectorCaller,
	ConnectorCalls,
	ExportLists,
	ImportWriter,
	ImportWriteTarget,
	MeterRegistry,
} from './capabilities.ts';
import { parseCsvRecord } from './csv-record.ts';
import type { AdapterCatalogue, RegisteredAdapter } from './registry.ts';
import type {
	AdaptersRepository,
	RowCounts,
	RunPage,
	RunPosition,
	RunRowPage,
} from './repository.ts';
import {
	callFailure,
	retryDelay,
	thrownFailure,
	type PageFailure,
} from './retry.ts';
import { AdaptersServiceError } from './service-error.ts';

export interface AdaptersServiceOptions {
	readonly repository: AdaptersRepository;
	readonly catalogue: AdapterCatalogue;
	/* Resolved at the point of use, so an optional provider composed after this
	   module is found and an absent one answers its stable refusal. */
	readonly calls: () => ConnectorCalls | undefined;
	readonly writer: () => ImportWriter | undefined;
	readonly lists: () => ExportLists | undefined;
	readonly meters: () => MeterRegistry | undefined;
	/** The live principal of an active member, or null. */
	readonly principal: (
		tenantId: string,
		accountId: string,
	) => Promise<AuthPrincipal | null>;
	/** The workspace zone a cron slot is computed in. */
	readonly timeZone: (tenantId: string) => Promise<string>;
	/** False in production: an unbound adapter never answers from its fixture. */
	readonly recordedAllowed: boolean;
	/** Called after a run is queued, so the run loop can pick it up at once. */
	readonly onQueued?: (() => void) | undefined;
	readonly now?: () => number;
	readonly newId?: () => string;
	readonly random?: () => number;
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface BindInput {
	readonly adapterId: string;
	readonly instanceId: string | null;
	readonly enabled: boolean;
	/** Null keeps the registered mapping. */
	readonly mapping: unknown;
	/** Null for the registered schedule, empty for on demand only. */
	readonly schedule: string | null;
}

export type AdapterTargetView =
	| {
			readonly kind: 'port';
			readonly available: boolean;
			readonly label: string | null;
			readonly fields: ImportWriteTarget['fields'];
			readonly naturalKey: readonly string[];
	  }
	| {
			readonly kind: 'list';
			readonly available: boolean;
			readonly label: string | null;
			readonly columns: readonly {
				readonly key: string;
				readonly header: string;
			}[];
	  };

export interface AdapterView {
	readonly id: string;
	readonly moduleId: string;
	readonly label: string;
	readonly direction: AdapterRegistration['direction'];
	readonly connector: string;
	readonly operation: string;
	readonly port: string;
	readonly schedule: string | null;
	readonly mapping: readonly AdapterMappingRule[];
	readonly recorded: boolean;
	readonly target: AdapterTargetView;
	readonly binding: Omit<AdapterBinding, 'tenantId'> | null;
	readonly lastRun: AdapterRun | null;
}

export interface DryRunRow {
	readonly index: number;
	readonly values: Readonly<Record<string, string>>;
	readonly outcome: 'valid' | 'invalid';
	readonly field: string | null;
	readonly code: string | null;
}

export interface DryRunResult {
	readonly read: number;
	readonly more: boolean;
	readonly rows: readonly DryRunRow[];
}

interface Transport {
	call(
		input: AdapterJsonObject,
		idempotencyKey: string | undefined,
		signal: AbortSignal,
	): Promise<ConnectorCallAnswer>;
}

type SourceTarget = ImportWriteTarget & { readonly portKey: string };

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CLAIM_LOST = 'CLAIM_LOST';

function failure(code: string, message: string, status = 400) {
	return new AdaptersServiceError(code, message, status);
}

function bounded(value: string | undefined | null, max: number): string | null {
	if (value === undefined || value === null) return null;
	const trimmed = value.trim();
	if (trimmed === '') return null;
	return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(claimLost());
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(claimLost());
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/* import.write.v1 refuses a whole call with a code of import.core; the run
   records one of its own, so the screen explains it in this module's words. */
function portFailure(error: unknown): AdaptersServiceError {
	const code = (error as { code?: unknown } | null)?.code;
	if (code === 'TARGET_FORBIDDEN' || code === 'PRINCIPAL_TENANT_MISMATCH') {
		return failure(
			'ADAPTER_PORT_FORBIDDEN',
			'The account this run acts for may not write through the port.',
			403,
		);
	}
	if (code === 'TARGET_UNKNOWN') {
		return failure(
			'ADAPTER_TARGET_UNAVAILABLE',
			'The import port this adapter writes is not registered.',
			409,
		);
	}
	return failure(
		'ADAPTER_PORT_FAILED',
		'The import port refused the batch.',
		502,
	);
}

function claimLost(): AdaptersServiceError {
	return failure(
		CLAIM_LOST,
		'Another process took this run over, or it was cancelled.',
		409,
	);
}

function checkpoint(signal: AbortSignal): void {
	if (signal.aborted) throw claimLost();
}

/** The effective cron of a binding, or null when it runs on demand. */
function effectiveSchedule(
	registration: AdapterRegistration,
	binding: Pick<AdapterBinding, 'schedule'> | null,
): string | null {
	const override = binding?.schedule ?? null;
	if (override === null) return registration.schedule ?? null;
	return override === '' ? null : override;
}

export class AdaptersService {
	readonly #options: AdaptersServiceOptions;
	readonly #now: () => number;
	readonly #newId: () => string;
	readonly #random: () => number;
	readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;

	constructor(options: AdaptersServiceOptions) {
		this.#options = options;
		this.#now = options.now ?? (() => Date.now());
		this.#newId = options.newId ?? (() => randomUUID());
		this.#random = options.random ?? Math.random;
		this.#sleep = options.sleep ?? defaultSleep;
	}

	async overview(tenantId: string): Promise<readonly AdapterView[]> {
		const repository = this.#options.repository;
		const [bindings, runs] = await Promise.all([
			repository.listBindings(tenantId),
			repository.latestRuns(tenantId),
		]);
		const bound = new Map(bindings.map((entry) => [entry.adapterId, entry]));
		const last = new Map(runs.map((run) => [run.adapterId, run]));
		return this.#options.catalogue.list().map(({ moduleId, registration }) => {
			const binding = bound.get(registration.id) ?? null;
			return {
				id: registration.id,
				moduleId,
				label: registration.label,
				direction: registration.direction,
				connector: registration.connector,
				operation: registration.operation,
				port: registration.port,
				schedule: registration.schedule ?? null,
				mapping: registration.mapping,
				recorded:
					registration.recorded !== undefined && this.#options.recordedAllowed,
				target: this.#targetView(registration),
				binding: binding
					? {
							adapterId: binding.adapterId,
							instanceId: binding.instanceId,
							enabled: binding.enabled,
							mapping: binding.mapping,
							schedule: binding.schedule,
							nextRunAt: binding.nextRunAt,
							updatedBy: binding.updatedBy,
							updatedAt: binding.updatedAt,
						}
					: null,
				lastRun: last.get(registration.id) ?? null,
			};
		});
	}

	async bind(
		principal: AuthPrincipal,
		input: BindInput,
	): Promise<AdapterBinding> {
		const { registration } = this.#require(input.adapterId);
		const tenantId = principal.tenantId;
		if (
			input.instanceId !== null &&
			(input.instanceId.length === 0 ||
				input.instanceId.length > ADAPTER_LIMITS.instanceId)
		) {
			throw failure('INVALID_INPUT', 'The instance id is not bounded text.');
		}
		const mapping =
			input.mapping === null
				? null
				: this.#readMapping(input.mapping, registration);
		if (input.schedule !== null && input.schedule !== '') {
			try {
				parseCron(input.schedule);
			} catch {
				throw failure(
					'ADAPTER_SCHEDULE_INVALID',
					'The schedule is not a five-field cron.',
				);
			}
		}
		if (mapping !== null || input.enabled) {
			this.#assertTarget(
				mapping ?? registration.mapping,
				this.#requireTarget(registration),
			);
		}
		if (
			input.enabled &&
			input.instanceId === null &&
			!(registration.recorded && this.#options.recordedAllowed)
		) {
			throw failure(
				'ADAPTER_NOT_BOUND',
				'Bind a connector instance before enabling this adapter.',
				409,
			);
		}
		const now = this.#now();
		const cron = effectiveSchedule(registration, { schedule: input.schedule });
		const nextRunAt =
			input.enabled && cron !== null
				? nextCronSlot(
						parseCron(cron),
						now,
						await this.#options.timeZone(tenantId),
					)
				: null;
		const previous = await this.#options.repository.findBinding(
			tenantId,
			registration.id,
		);
		const binding: AdapterBinding = {
			tenantId,
			adapterId: registration.id,
			instanceId: input.instanceId,
			enabled: input.enabled,
			mapping,
			schedule: input.schedule,
			nextRunAt,
			updatedBy: principal.accountId,
			updatedAt: now,
		};
		const events = [
			this.#event(
				tenantId,
				registration.id,
				'binding-saved',
				principal.accountId,
				null,
				{
					instanceChanged: (previous?.instanceId ?? null) !== input.instanceId,
					mappingChanged:
						JSON.stringify(previous?.mapping ?? null) !==
						JSON.stringify(mapping),
					scheduleChanged: (previous?.schedule ?? null) !== input.schedule,
				},
			),
		];
		if ((previous?.enabled ?? false) !== input.enabled) {
			events.push(
				this.#event(
					tenantId,
					registration.id,
					input.enabled ? 'binding-enabled' : 'binding-disabled',
					principal.accountId,
					null,
					{},
				),
			);
		}
		return this.#options.repository.saveBinding(binding, events);
	}

	async dryRun(
		principal: AuthPrincipal,
		adapterId: string,
		rawMapping: unknown,
	): Promise<DryRunResult> {
		const { moduleId, registration } = this.#require(adapterId);
		const tenantId = principal.tenantId;
		const binding = await this.#options.repository.findBinding(
			tenantId,
			registration.id,
		);
		const mapping =
			rawMapping === null || rawMapping === undefined
				? (binding?.mapping ?? registration.mapping)
				: this.#readMapping(rawMapping, registration);
		const limit = ADAPTER_LIMITS.dryRunRows;

		if (registration.direction === 'sink') {
			const list = this.#requireList(registration, principal);
			this.#assertTarget(mapping, {
				direction: 'sink',
				columns: list.columns.map((column) => column.key),
			});
			const page = await this.#listPage(list, principal, null, limit);
			const rows = page.records.map((record, index): DryRunRow => {
				const mapped = applyMapping(mapping, record);
				return mapped.ok
					? {
							index: index + 1,
							values: mapped.values,
							outcome: 'valid',
							field: null,
							code: null,
						}
					: {
							index: index + 1,
							values: {},
							outcome: 'invalid',
							field: mapped.field,
							code: mapped.code,
						};
			});
			return {
				read: page.records.length,
				more: page.nextCursor !== null,
				rows,
			};
		}

		const target = this.#requireSource(registration);
		/* The preview shows another system's records mapped for the port, so it
		   is only for someone who may write through that port. */
		if (!principal.scopes.includes(target.permission)) {
			throw failure(
				'ADAPTER_PORT_FORBIDDEN',
				'You may not write through the import port of this adapter.',
				403,
			);
		}
		this.#assertTarget(mapping, target);
		const transport = await this.#transport(
			tenantId,
			moduleId,
			registration,
			binding,
			undefined,
		);
		const controller = new AbortController();
		const answer = await transport.call(
			this.#pageInput(registration, null),
			undefined,
			controller.signal,
		);
		if (answer.outcome !== 'succeeded') {
			const { code } = callFailure(answer);
			throw failure(code, 'The service did not answer the first page.', 502);
		}
		const records = this.#records(registration, answer.body);
		const more =
			this.#nextCursor(registration, answer.body, null, records.length) !==
			null;
		const mapped = records.slice(0, limit).map((record, index) => ({
			index: index + 1,
			result: applyMapping(mapping, record),
		}));
		const valid = mapped.flatMap((entry) =>
			entry.result.ok
				? [{ row: entry.index, values: entry.result.values }]
				: [],
		);
		const verdicts = new Map<number, { field?: string; reason?: string }>();
		for (let start = 0; start < valid.length; start += target.batchSize) {
			const answered = await this.#requireWriter()
				.validate({
					tenantId,
					principal,
					moduleId: target.moduleId,
					portKey: target.portKey,
					rows: valid.slice(start, start + target.batchSize),
				})
				.catch((error: unknown) => {
					throw portFailure(error);
				});
			for (const verdict of answered) {
				if (verdict.verdict === 'invalid') verdicts.set(verdict.row, verdict);
			}
		}
		return {
			read: records.length,
			more,
			rows: mapped.map(({ index, result }): DryRunRow => {
				if (!result.ok) {
					return {
						index,
						values: {},
						outcome: 'invalid',
						field: result.field,
						code: result.code,
					};
				}
				const verdict = verdicts.get(index);
				return {
					index,
					values: result.values,
					outcome: verdict ? 'invalid' : 'valid',
					field: bounded(verdict?.field, ADAPTER_LIMITS.message),
					code: bounded(verdict?.reason, ADAPTER_LIMITS.errorCode),
				};
			}),
		};
	}

	async start(
		principal: AuthPrincipal,
		adapterId: string,
	): Promise<AdapterRun> {
		const { registration } = this.#require(adapterId);
		await this.#assertRunnable(principal.tenantId, registration);
		return this.#queue(principal, registration, 'manual', null, 'run-started');
	}

	async resume(principal: AuthPrincipal, runId: string): Promise<AdapterRun> {
		const previous = await this.#requireRun(principal.tenantId, runId);
		const { registration } = this.#require(previous.adapterId);
		const latest = await this.#options.repository.latestRun(
			principal.tenantId,
			previous.adapterId,
		);
		if (
			latest?.id !== previous.id ||
			(previous.status !== 'failed' && previous.status !== 'cancelled') ||
			previous.cursor === null
		) {
			throw failure(
				'ADAPTER_RUN_NOT_RESUMABLE',
				'Only the most recent failed or cancelled run with a stored cursor can be resumed.',
				409,
			);
		}
		await this.#assertRunnable(principal.tenantId, registration);
		return this.#queue(
			principal,
			registration,
			'resume',
			previous,
			'run-resumed',
		);
	}

	async cancel(principal: AuthPrincipal, runId: string): Promise<AdapterRun> {
		const run = await this.#requireRun(principal.tenantId, runId);
		const cancelled = await this.#options.repository.cancelRun(
			principal.tenantId,
			run.id,
			this.#now(),
			this.#event(
				principal.tenantId,
				run.adapterId,
				'run-cancelled',
				principal.accountId,
				run.id,
				{ status: run.status },
			),
		);
		if (!cancelled) {
			throw failure(
				'ADAPTER_RUN_NOT_ACTIVE',
				'Only a queued or running run can be cancelled.',
				409,
			);
		}
		return cancelled;
	}

	async run(tenantId: string, runId: string): Promise<AdapterRun> {
		return this.#requireRun(tenantId, runId);
	}

	async runs(
		tenantId: string,
		query: {
			readonly adapterId?: string | undefined;
			readonly limit: number;
			readonly after?: RunPosition | null | undefined;
		},
	): Promise<RunPage> {
		return this.#options.repository.listRuns(tenantId, query);
	}

	async rows(
		tenantId: string,
		runId: string,
		limit: number,
		after: number | null,
	): Promise<RunRowPage> {
		await this.#requireRun(tenantId, runId);
		return this.#options.repository.listRunRows(tenantId, runId, limit, after);
	}

	/**
	 * One claimed run, from its stored cursor to its end. It never throws: a
	 * failure is the run's recorded outcome with its cursor kept, and a lost
	 * claim or a cancel records nothing, because the run is no longer this
	 * stage's to settle.
	 */
	async perform(
		run: AdapterRun,
		claimedBy: string,
		signal: AbortSignal,
	): Promise<void> {
		try {
			await this.#execute(run, claimedBy, signal);
			await this.#options.repository.finishRun({
				tenantId: run.tenantId,
				runId: run.id,
				claimedBy,
				status: 'succeeded',
				errorCode: null,
				at: this.#now(),
			});
		} catch (error) {
			if (signal.aborted) return;
			const code =
				error instanceof AdaptersServiceError ||
				error instanceof AdapterMappingError
					? error.code
					: 'ADAPTER_RUN_FAILED';
			if (code === CLAIM_LOST) return;
			await this.#options.repository.finishRun({
				tenantId: run.tenantId,
				runId: run.id,
				claimedBy,
				status: 'failed',
				errorCode: CODE.test(code) ? code : 'ADAPTER_RUN_FAILED',
				at: this.#now(),
			});
		}
	}

	/**
	 * One due binding. The compare and swap on its next time is the fence, so
	 * two processes reading the same due row queue one run at most.
	 */
	async fire(due: AdapterDueBinding): Promise<void> {
		const registered = this.#options.catalogue.find(due.adapterId);
		const binding = await this.#options.repository.findBinding(
			due.tenantId,
			due.adapterId,
		);
		const cron =
			registered && binding
				? effectiveSchedule(registered.registration, binding)
				: null;
		const now = this.#now();
		const next =
			cron === null
				? null
				: nextCronSlot(
						parseCron(cron),
						Math.max(now, due.nextRunAt),
						await this.#options.timeZone(due.tenantId),
					);
		if (!registered || cron === null) {
			await this.#options.repository.fireSchedule({
				tenantId: due.tenantId,
				adapterId: due.adapterId,
				seen: due.nextRunAt,
				next: null,
				run: null,
			});
			return;
		}
		const registration = registered.registration;
		const result = await this.#options.repository.fireSchedule({
			tenantId: due.tenantId,
			adapterId: due.adapterId,
			seen: due.nextRunAt,
			next,
			run: (startedBy) =>
				this.#newRun(
					due.tenantId,
					registration,
					'schedule',
					startedBy,
					null,
					now,
				),
			audit: (action, startedBy, runId) =>
				this.#event(due.tenantId, registration.id, action, startedBy, runId, {
					trigger: 'schedule',
					slot: due.nextRunAt,
				}),
		});
		if (result === 'queued') this.#options.onQueued?.();
	}

	async #execute(
		run: AdapterRun,
		claimedBy: string,
		signal: AbortSignal,
	): Promise<void> {
		/* A committed page without a next cursor was the last one: a process
		   that died before settling the run leaves nothing to read again. */
		if (run.pages > 0 && run.cursor === null) return;
		const registered = this.#options.catalogue.find(run.adapterId);
		if (!registered) {
			throw failure(
				'ADAPTER_UNKNOWN',
				'No module registers this adapter.',
				404,
			);
		}
		const { moduleId, registration } = registered;
		const principal =
			run.startedBy === null
				? null
				: await this.#options.principal(run.tenantId, run.startedBy);
		if (!principal) {
			throw failure(
				'ADAPTER_PRINCIPAL_UNAVAILABLE',
				'The account this run acts for is no longer an active member.',
				409,
			);
		}
		if (!principal.scopes.includes(ADAPTERS_PERMISSIONS.manage)) {
			throw failure(
				'ADAPTER_PRINCIPAL_FORBIDDEN',
				'The account this run acts for no longer manages adapters.',
				403,
			);
		}
		const binding = await this.#options.repository.findBinding(
			run.tenantId,
			run.adapterId,
		);
		if (!binding?.enabled) {
			throw failure('ADAPTER_DISABLED', 'This adapter is switched off.', 409);
		}
		const mapping = binding.mapping ?? registration.mapping;
		const context = {
			run,
			claimedBy,
			signal,
			registration,
			principal,
			mapping,
		};
		if (registration.direction === 'sink') {
			const list = this.#requireList(registration, principal);
			this.#assertTarget(mapping, {
				direction: 'sink',
				columns: list.columns.map((column) => column.key),
			});
			const transport = await this.#transport(
				run.tenantId,
				moduleId,
				registration,
				binding,
				run.id,
			);
			await this.#push(context, list, transport);
			return;
		}
		const target = this.#requireSource(registration);
		this.#assertTarget(mapping, target);
		const transport = await this.#transport(
			run.tenantId,
			moduleId,
			registration,
			binding,
			run.id,
		);
		await this.#pull(context, target, transport);
	}

	async #pull(
		context: RunContext,
		target: SourceTarget,
		transport: Transport,
	): Promise<void> {
		const { run, claimedBy, signal, registration, principal, mapping } =
			context;
		const writer = this.#requireWriter();
		let cursor = run.cursor;
		let pages = run.pages;
		let read = run.rowsRead;
		for (;;) {
			checkpoint(signal);
			if (pages >= ADAPTER_LIMITS.pagesPerRun) {
				throw failure(
					'ADAPTER_PAGES_EXCEEDED',
					`A run reads at most ${ADAPTER_LIMITS.pagesPerRun} pages; resume it to go on.`,
					409,
				);
			}
			const body = await this.#call(
				transport,
				this.#pageInput(registration, cursor),
				undefined,
				signal,
			);
			const records = this.#records(registration, body);
			if (registration.paging?.kind === 'page' && records.length === 0) return;
			const next = this.#nextCursor(registration, body, cursor, records.length);

			const rows: AdapterRunRow[] = [];
			const counts = {
				read: records.length,
				created: 0,
				updated: 0,
				skipped: 0,
				failed: 0,
			};
			const pending: {
				row: number;
				values: Readonly<Record<string, string>>;
			}[] = [];
			records.forEach((record, position) => {
				const index = read + position + 1;
				const mapped = applyMapping(mapping, record);
				if (mapped.ok) {
					pending.push({ row: index, values: mapped.values });
					return;
				}
				counts.failed += 1;
				rows.push(
					this.#row(run, index, null, 'invalid', mapped.code, mapped.field),
				);
			});
			for (let start = 0; start < pending.length; start += target.batchSize) {
				checkpoint(signal);
				const batch = pending.slice(start, start + target.batchSize);
				const values = new Map(batch.map((entry) => [entry.row, entry.values]));
				const outcomes = await writer
					.write({
						tenantId: run.tenantId,
						principal,
						moduleId: target.moduleId,
						portKey: target.portKey,
						rows: batch,
						mode: registration.mode ?? 'update-existing',
						sourceRef: run.id,
					})
					.catch((error: unknown) => {
						throw portFailure(error);
					});
				for (const outcome of outcomes) {
					if (!values.has(outcome.row)) continue;
					if (outcome.outcome === 'created') counts.created += 1;
					else if (outcome.outcome === 'updated') counts.updated += 1;
					else if (outcome.outcome === 'skipped') counts.skipped += 1;
					else counts.failed += 1;
					const reason = outcome.reason;
					rows.push(
						this.#row(
							run,
							outcome.row,
							this.#naturalKey(target, values.get(outcome.row)!),
							outcome.outcome,
							reason !== undefined && CODE.test(reason) ? reason : null,
							outcome.field ??
								(reason !== undefined && !CODE.test(reason)
									? reason
									: undefined),
						),
					);
				}
			}
			checkpoint(signal);
			await this.#commit(
				run,
				claimedBy,
				next,
				rows,
				counts,
				pages + 1,
				counts.created + counts.updated,
			);
			pages += 1;
			read += records.length;
			cursor = next;
			if (next === null) return;
		}
	}

	async #push(
		context: RunContext,
		list: ListDefinition,
		transport: Transport,
	): Promise<void> {
		const { run, claimedBy, signal, registration, principal, mapping } =
			context;
		const batchSize = registration.batchSize ?? ADAPTER_LIMITS.sinkBatch;
		const items = registration.items ?? '';
		/* A resumed run pushes under the keys of the run the walk began in, so a
		   batch the service accepted before the failure is answered from the
		   connectors ledger instead of being sent again. */
		const keyScope = run.resumedFrom ?? run.id;
		/* The stored cursor of a sink is its position in the walk. A list signs
		   its cursors with a secret of its own process, so a reclaimed or resumed
		   walk reads the list from its start again and skips the rows before that
		   position rather than trusting a cursor another process signed. */
		const resumeAt = run.cursor === null ? 0 : Number(run.cursor);
		if (!Number.isSafeInteger(resumeAt) || resumeAt < 0) {
			throw failure(
				'ADAPTER_CURSOR_INVALID',
				'The stored position of this push is not a row count.',
				409,
			);
		}
		let listCursor: string | null = null;
		let walked = 0;
		let pages = run.pages;
		for (;;) {
			checkpoint(signal);
			if (pages >= ADAPTER_LIMITS.pagesPerRun) {
				throw failure(
					'ADAPTER_PAGES_EXCEEDED',
					`A run reads at most ${ADAPTER_LIMITS.pagesPerRun} pages; resume it to go on.`,
					409,
				);
			}
			const page = await this.#listPage(
				list,
				principal,
				listCursor,
				ADAPTER_LIMITS.page,
			);
			const pageStart = walked;
			walked += page.records.length;
			listCursor = page.nextCursor;
			if (walked <= resumeAt) {
				if (listCursor === null) return;
				continue;
			}
			const rows: AdapterRunRow[] = [];
			const counts = {
				read: 0,
				created: 0,
				updated: 0,
				skipped: 0,
				failed: 0,
			};
			const pending: { index: number; record: AdapterJsonObject }[] = [];
			page.records.forEach((record, position) => {
				const index = pageStart + position + 1;
				if (index <= resumeAt) return;
				counts.read += 1;
				const mapped = applyMapping(mapping, record);
				if (!mapped.ok) {
					counts.failed += 1;
					rows.push(
						this.#row(run, index, null, 'invalid', mapped.code, mapped.field),
					);
					return;
				}
				let pushed: AdapterJsonObject = {};
				for (const [path, value] of Object.entries(mapped.values)) {
					pushed = writePath(pushed, path, value);
				}
				pending.push({ index, record: pushed });
			});
			for (let start = 0; start < pending.length; start += batchSize) {
				const slice = pending.slice(start, start + batchSize);
				const key = createHash('sha256')
					.update(`${keyScope}\n${slice[0]!.index}`)
					.digest('hex');
				await this.#call(
					transport,
					writePath(
						registration.input ?? {},
						items,
						slice.map((entry) => entry.record),
					),
					`adapters:${key}`,
					signal,
				);
				for (const entry of slice) {
					counts.created += 1;
					rows.push(
						this.#row(run, entry.index, null, 'pushed', null, undefined),
					);
				}
			}
			checkpoint(signal);
			await this.#commit(
				run,
				claimedBy,
				listCursor === null ? null : String(walked),
				rows,
				counts,
				pages + 1,
				counts.created,
			);
			pages += 1;
			if (listCursor === null) return;
		}
	}

	async #commit(
		run: AdapterRun,
		claimedBy: string,
		cursor: string | null,
		rows: readonly AdapterRunRow[],
		counts: RowCounts,
		page: number,
		written: number,
	): Promise<void> {
		const committed = await this.#options.repository.commitPage({
			tenantId: run.tenantId,
			runId: run.id,
			claimedBy,
			cursor,
			rows,
			counts,
		});
		if (!committed) throw claimLost();
		const meters = this.#options.meters();
		if (meters && written > 0) {
			/* A meter is bookkeeping of what already happened; a refusal to count
			   it never undoes or fails the page. */
			await meters
				.record({
					tenantId: run.tenantId,
					meter: `${ADAPTERS_MODULE_ID}.rows`,
					amount: written,
					sourceRef: `${run.id}:${page}`,
				})
				.catch(() => undefined);
		}
	}

	/**
	 * One call with the page retry policy; answers the body of a success. A
	 * keyed call takes the next key slot per try. A slot the connectors ledger
	 * already bound to a failure, or to another input after a mapping change,
	 * is spent rather than tried, so a resumed push replays what the service
	 * accepted and tries again what it refused.
	 */
	async #call(
		transport: Transport,
		input: AdapterJsonObject,
		idempotencyKey: string | undefined,
		signal: AbortSignal,
	): Promise<unknown> {
		let last: PageFailure | null = null;
		let attempts = 0;
		let slot = 0;
		let wait = false;
		while (
			attempts < ADAPTER_LIMITS.attemptsPerPage &&
			slot < ADAPTER_LIMITS.keySlots
		) {
			if (wait) {
				await this.#sleep(
					retryDelay(attempts, last?.retryAfterMs ?? null, this.#random),
					signal,
				);
				wait = false;
			}
			checkpoint(signal);
			slot += 1;
			const key =
				idempotencyKey === undefined ? undefined : `${idempotencyKey}:${slot}`;
			let answer: ConnectorCallAnswer;
			try {
				answer = await transport.call(input, key, signal);
			} catch (error) {
				if (signal.aborted) throw claimLost();
				if (
					key !== undefined &&
					(error as { code?: unknown } | null)?.code ===
						'CALL_IDEMPOTENCY_CONFLICT'
				) {
					continue;
				}
				attempts += 1;
				last = thrownFailure(error);
				if (!last.retryable) break;
				wait = true;
				continue;
			}
			if (answer.outcome === 'succeeded') return answer.body;
			if (answer.replayed) continue;
			attempts += 1;
			last = callFailure(answer);
			if (!last.retryable) break;
			wait = true;
		}
		throw failure(
			last?.code ?? 'ADAPTER_CALL_FAILED',
			'The service did not answer the page.',
			502,
		);
	}

	async #transport(
		tenantId: string,
		moduleId: string,
		registration: AdapterRegistration,
		binding: AdapterBinding | null,
		callerRef: string | undefined,
	): Promise<Transport> {
		const instanceId = binding?.instanceId ?? null;
		/* An adapter is unattended work, so a run and the owner's dry run alike
		   need the instance's workflow consent: binding an instance id is never
		   a way around it. */
		const caller: ConnectorCaller = 'workflow';
		if (instanceId !== null) {
			const calls = this.#options.calls();
			if (!calls) {
				throw failure(
					'ADAPTER_CONNECTORS_UNAVAILABLE',
					'Connectors is not available in this deployment.',
					409,
				);
			}
			if (!(await calls.consented(tenantId, instanceId, caller))) {
				throw failure(
					'ADAPTER_CONSENT_MISSING',
					'The bound connector instance does not admit this call.',
					409,
				);
			}
			return {
				call: (input, idempotencyKey, signal) =>
					calls.call({
						tenantId,
						instanceId,
						operation: registration.operation,
						input,
						caller,
						...(callerRef === undefined ? {} : { callerRef }),
						...(idempotencyKey === undefined ? {} : { idempotencyKey }),
						signal,
					}),
			};
		}
		const fixture = registration.recorded;
		if (!fixture || !this.#options.recordedAllowed) {
			throw failure(
				'ADAPTER_NOT_BOUND',
				`The adapter of ${moduleId} is bound to no connector instance.`,
				409,
			);
		}
		return {
			call: async (input) => {
				const body = recordedAnswer(fixture, input);
				if (body === undefined) {
					throw failure(
						'ADAPTER_RECORDED_CALL_MISSING',
						'The recorded fixture holds no answer for this call.',
						409,
					);
				}
				return {
					callId: 'recorded',
					outcome: 'succeeded',
					status: 200,
					errorClass: null,
					body,
					replayed: false,
					retryAfterMs: null,
				};
			},
		};
	}

	#pageInput(
		registration: AdapterRegistration,
		cursor: string | null,
	): AdapterJsonObject {
		const input = registration.input ?? {};
		const paging = registration.paging;
		if (!paging) return input;
		if (paging.kind === 'cursor') {
			return cursor === null ? input : writePath(input, paging.param, cursor);
		}
		const page = cursor === null ? (paging.start ?? 1) : Number(cursor);
		return writePath(input, paging.param, page);
	}

	#records(
		registration: AdapterRegistration,
		body: unknown,
	): readonly unknown[] {
		const records = readPath(body, registration.items ?? '');
		if (!Array.isArray(records)) {
			throw failure(
				'ADAPTER_RESPONSE_INVALID',
				'The answer carries no record array at the declared path.',
				502,
			);
		}
		if (records.length > ADAPTER_LIMITS.recordsPerPage) {
			throw failure(
				'ADAPTER_PAGE_TOO_LARGE',
				`A page carries at most ${ADAPTER_LIMITS.recordsPerPage} records.`,
				502,
			);
		}
		return records;
	}

	#nextCursor(
		registration: AdapterRegistration,
		body: unknown,
		cursor: string | null,
		records: number,
	): string | null {
		const paging = registration.paging;
		if (!paging) return null;
		if (paging.kind === 'page') {
			if (records === 0) return null;
			const page = cursor === null ? (paging.start ?? 1) : Number(cursor);
			return String(page + 1);
		}
		const raw = readPath(body, paging.next);
		if (raw === undefined || raw === null || raw === '') return null;
		if (typeof raw !== 'string' && typeof raw !== 'number') {
			throw failure(
				'ADAPTER_CURSOR_INVALID',
				'The answer carries a next cursor that is not text.',
				502,
			);
		}
		const next = String(raw);
		if (next.length > ADAPTER_LIMITS.cursor) {
			throw failure(
				'ADAPTER_CURSOR_INVALID',
				'The next cursor is longer than 2048 characters.',
				502,
			);
		}
		if (next === cursor) {
			throw failure(
				'ADAPTER_CURSOR_STALLED',
				'The service answered the cursor it was given.',
				502,
			);
		}
		return next;
	}

	async #listPage(
		list: ListDefinition,
		principal: AuthPrincipal,
		cursor: string | null,
		limit: number,
	): Promise<{
		readonly records: readonly AdapterJsonObject[];
		readonly nextCursor: string | null;
	}> {
		let page: Awaited<ReturnType<ListDefinition['page']>>;
		try {
			page = await list.page(principal, cursor, limit);
		} catch {
			throw failure(
				'ADAPTER_LIST_FAILED',
				'The list could not answer a page.',
				502,
			);
		}
		const keys = list.columns.map((column) => column.key);
		const records = page.records.map((serialized) => {
			let cells: string[];
			try {
				cells = parseCsvRecord(serialized);
			} catch {
				throw failure(
					'ADAPTER_LIST_FAILED',
					'The list answered a malformed row.',
					502,
				);
			}
			const record: Record<string, AdapterJson> = {};
			keys.forEach((key, index) => {
				const cell = cells[index] ?? '';
				if (cell !== '') record[key] = cell;
			});
			return record;
		});
		return { records, nextCursor: page.nextCursor };
	}

	#row(
		run: AdapterRun,
		index: number,
		naturalKey: string | null,
		outcome: AdapterRunRow['outcome'],
		errorCode: string | null,
		message: string | undefined,
	): AdapterRunRow {
		return {
			tenantId: run.tenantId,
			runId: run.id,
			rowIndex: index,
			naturalKey: bounded(naturalKey, ADAPTER_LIMITS.naturalKey),
			outcome,
			errorCode: bounded(errorCode, ADAPTER_LIMITS.errorCode),
			message: bounded(message, ADAPTER_LIMITS.message),
		};
	}

	#naturalKey(
		target: SourceTarget,
		values: Readonly<Record<string, string>>,
	): string | null {
		const key = target.naturalKey
			.map((field) => values[field] ?? '')
			.filter((value) => value !== '')
			.join(' / ');
		return key === '' ? null : key;
	}

	async #assertRunnable(
		tenantId: string,
		registration: AdapterRegistration,
	): Promise<void> {
		const binding = await this.#options.repository.findBinding(
			tenantId,
			registration.id,
		);
		if (!binding?.enabled) {
			throw failure('ADAPTER_DISABLED', 'This adapter is switched off.', 409);
		}
	}

	async #queue(
		principal: AuthPrincipal,
		registration: AdapterRegistration,
		trigger: AdapterRunTrigger,
		previous: AdapterRun | null,
		action: 'run-started' | 'run-resumed',
	): Promise<AdapterRun> {
		const run = this.#newRun(
			principal.tenantId,
			registration,
			trigger,
			principal.accountId,
			previous,
			this.#now(),
		);
		const queued = await this.#options.repository.createRun(
			run,
			this.#event(
				principal.tenantId,
				registration.id,
				action,
				principal.accountId,
				run.id,
				previous ? { trigger, resumedFrom: previous.id } : { trigger },
			),
		);
		if (!queued) {
			throw failure(
				'ADAPTER_RUN_ACTIVE',
				'A run of this adapter is already queued or running.',
				409,
			);
		}
		this.#options.onQueued?.();
		return run;
	}

	#newRun(
		tenantId: string,
		registration: AdapterRegistration,
		trigger: AdapterRunTrigger,
		startedBy: string | null,
		previous: AdapterRun | null,
		at: number,
	): AdapterRun {
		return {
			id: this.#newId(),
			tenantId,
			adapterId: registration.id,
			direction: registration.direction,
			status: 'queued',
			trigger,
			resumedFrom: previous ? (previous.resumedFrom ?? previous.id) : null,
			cursor: previous?.cursor ?? null,
			pages: 0,
			rowsRead: 0,
			rowsCreated: 0,
			rowsUpdated: 0,
			rowsSkipped: 0,
			rowsFailed: 0,
			errorCode: null,
			claimedBy: null,
			leaseUntil: null,
			queuedAt: at,
			startedAt: null,
			finishedAt: null,
			startedBy,
		};
	}

	#event(
		tenantId: string,
		adapterId: string,
		action: AdapterAuditAction,
		actorId: string | null,
		runId: string | null,
		metadata: Readonly<Record<string, AdapterJson>>,
	): AdapterAuditEvent {
		return {
			id: this.#newId(),
			tenantId,
			adapterId,
			runId,
			action,
			actorId,
			metadata,
			occurredAt: this.#now(),
		};
	}

	#require(adapterId: string): RegisteredAdapter {
		const registered = this.#options.catalogue.find(adapterId);
		if (!registered) {
			throw failure(
				'ADAPTER_UNKNOWN',
				'No module registers this adapter.',
				404,
			);
		}
		return registered;
	}

	async #requireRun(tenantId: string, runId: string): Promise<AdapterRun> {
		const run = await this.#options.repository.findRun(tenantId, runId);
		if (!run) {
			throw failure(
				'ADAPTER_RUN_NOT_FOUND',
				'No such run in this workspace.',
				404,
			);
		}
		return run;
	}

	#readMapping(
		raw: unknown,
		registration: AdapterRegistration,
	): readonly AdapterMappingRule[] {
		return readMapping(raw, registration.direction);
	}

	#assertTarget(
		mapping: readonly AdapterMappingRule[],
		target: MappingTarget | SourceTarget,
	): void {
		assertMappingTarget(
			mapping,
			'direction' in target
				? target
				: { direction: 'source', fields: target.fields },
		);
	}

	#requireTarget(registration: AdapterRegistration): MappingTarget {
		if (registration.direction === 'sink') {
			const list = this.#options.lists()?.find(registration.port);
			if (!list) {
				throw failure(
					'ADAPTER_TARGET_UNAVAILABLE',
					'The list this adapter pushes is not registered.',
					409,
				);
			}
			return {
				direction: 'sink',
				columns: list.columns.map((column) => column.key),
			};
		}
		return {
			direction: 'source',
			fields: this.#requireSource(registration).fields,
		};
	}

	#requireWriter(): ImportWriter {
		const writer = this.#options.writer();
		if (!writer) {
			throw failure(
				'ADAPTER_TARGET_UNAVAILABLE',
				'Import is not available in this deployment.',
				409,
			);
		}
		return writer;
	}

	/* A port id is `<module id>.<key>` and a module id has dots of its own, so
	   every split is asked in turn; a port id has at most a few segments. */
	#findSource(registration: AdapterRegistration): SourceTarget | null {
		const writer = this.#options.writer();
		if (!writer) return null;
		const port = registration.port;
		for (
			let dot = port.indexOf('.');
			dot !== -1;
			dot = port.indexOf('.', dot + 1)
		) {
			const described = writer.describe(
				port.slice(0, dot),
				port.slice(dot + 1),
			);
			if (described) return { ...described, portKey: port.slice(dot + 1) };
		}
		return null;
	}

	#requireSource(registration: AdapterRegistration): SourceTarget {
		const target = this.#findSource(registration);
		if (!target) {
			throw failure(
				'ADAPTER_TARGET_UNAVAILABLE',
				'The import port this adapter writes is not registered.',
				409,
			);
		}
		return target;
	}

	#requireList(
		registration: AdapterRegistration,
		principal: AuthPrincipal,
	): ListDefinition {
		const list = this.#options.lists()?.find(registration.port);
		if (!list) {
			throw failure(
				'ADAPTER_TARGET_UNAVAILABLE',
				'The list this adapter pushes is not registered.',
				409,
			);
		}
		if (!principal.scopes.includes(list.permission)) {
			throw failure(
				'ADAPTER_LIST_FORBIDDEN',
				'The account this run acts for may not read the list.',
				403,
			);
		}
		return list;
	}

	#targetView(registration: AdapterRegistration): AdapterTargetView {
		if (registration.direction === 'sink') {
			const list = this.#options.lists()?.find(registration.port) ?? null;
			return {
				kind: 'list',
				available: list !== null,
				label: list?.label ?? null,
				columns: list?.columns ?? [],
			};
		}
		const target = this.#findSource(registration);
		return {
			kind: 'port',
			available: target !== null,
			label: target?.label ?? null,
			fields: target?.fields ?? [],
			naturalKey: target?.naturalKey ?? [],
		};
	}
}

type ListDefinition = NonNullable<ReturnType<ExportLists['find']>>;

interface RunContext {
	readonly run: AdapterRun;
	readonly claimedBy: string;
	readonly signal: AbortSignal;
	readonly registration: AdapterRegistration;
	readonly principal: AuthPrincipal;
	readonly mapping: readonly AdapterMappingRule[];
}
