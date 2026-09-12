import { readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	AUDIT_EVENT_ACTIONS,
	AUDIT_REASONS,
	AUDIT_SEALED_MARKER,
} from '../src/domain/types.ts';
import { createDataClassRegistry } from '@flowdular/kernel';
import { createAnchorSigner } from '../src/services/anchor-key.ts';
import { createErasureRegistry } from '../src/services/erasure-port.ts';
import {
	AuditErasureService,
	ERASURE_REQUEST_TTL_MS,
	erasureSubjectMarker,
	type ErasureCertificate,
} from '../src/services/erasure-service.ts';
import { AuditHoldService } from '../src/services/hold-service.ts';
import { AuditSealService } from '../src/services/seal-service.ts';
import {
	openAuditTestDatabase,
	type AuditTestDatabase,
} from './support/database.ts';
import { FakeOwnerModule, type FakeRow } from './support/fake-modules.ts';
import {
	openOperatorDirectory,
	type OperatorDirectory,
} from './support/operator.ts';

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const ALPHA = 'tenant-alpha';
const BETA = 'tenant-beta';
const SUBJECT = 'account-bob';
const OTHER = 'account-cleo';

let shared: AuditTestDatabase;
let operator: OperatorDirectory;

beforeAll(async () => {
	shared = await openAuditTestDatabase();
	operator = await openOperatorDirectory();
});

afterAll(async () => {
	await shared?.dispose();
	await operator?.cleanup();
});

afterEach(async () => {
	await shared.reset();
	for (const name of await readdir(operator.allowed)) {
		await rm(resolve(operator.allowed, name), { force: true });
	}
});

function rows(
	tenantId: string,
	subject: string,
	count: number,
): readonly FakeRow[] {
	return Array.from({ length: count }, (_, index) => ({
		tenantId,
		id: `${tenantId}-${subject}-${index}`,
		at: NOW,
		payload: { subject },
	}));
}

/**
 * One declaring module and one class nobody can erase, composed the way the
 * platform composes them. `route` says where the erase operation comes from:
 * the data class declaration, or the audit.erasure.v1 adapter a module that
 * composes later may use instead.
 */
function fixture(
	options: {
		readonly count?: boolean;
		readonly route?: 'declaration' | 'capability';
	} = {},
) {
	const owner = new FakeOwnerModule('agents.core', 'runs', [
		...rows(ALPHA, SUBJECT, 3),
		...rows(ALPHA, OTHER, 2),
		...rows(BETA, SUBJECT, 4),
	]);
	const silent = new FakeOwnerModule('documents.core', 'documents');
	const capability = options.route === 'capability';
	const dataClasses = createDataClassRegistry();
	dataClasses.declare(owner.moduleId, [
		owner.declaration(
			capability
				? { erase: undefined, count: undefined }
				: options.count === false
					? { count: undefined }
					: {},
		),
	]);
	/* A class whose owner declares no erase operation: the plan and the
	   certificate name it rather than leaving it out. */
	dataClasses.declare(silent.moduleId, [
		silent.declaration({ erase: undefined, count: undefined }),
	]);
	dataClasses.seal();
	const registry = createErasureRegistry();
	if (capability) registry.register(owner.erasureEntry(options));
	registry.seal();
	const holds = new AuditHoldService(shared.repository, () => NOW);
	/* Advanced between two runs of one test: a certificate is named after the
	   moment it was written, so two runs at the same instant collide on the
	   file the first one created. */
	const clock = { now: NOW };
	const erasures = new AuditErasureService({
		repository: shared.repository,
		holds,
		dataClasses,
		adapter: registry,
		environment: operator.environment,
		workspaceRoot: operator.workspaceRoot,
		now: () => clock.now,
	});
	return { owner, silent, dataClasses, registry, holds, erasures, clock };
}

/** The outcome of the class nobody can erase, which every run has to name. */
const NOT_ERASABLE = {
	moduleId: 'documents.core',
	classId: 'documents.core.documents',
	outcome: 'not-erasable',
	rows: null,
} as const;

function request(overrides: Record<string, unknown> = {}) {
	return {
		tenantId: ALPHA,
		subject: SUBJECT,
		slug: 'alpha',
		name: 'Alpha',
		operator: 'cli:ada',
		outputDirectory: operator.allowed,
		apply: true,
		destroyKey: false,
		...overrides,
	} as Parameters<AuditErasureService['run']>[0];
}

async function certificates(): Promise<readonly string[]> {
	return (await readdir(operator.allowed)).filter((name) =>
		name.endsWith('.json'),
	);
}

describe('AUDIT-ERASE-DRY-RUN', () => {
	it('lists the count per module and class and writes nothing', async () => {
		const { owner, erasures } = fixture();

		const result = await erasures.run(request({ apply: false }));

		expect(result.applied).toBe(false);
		expect(result.classes).toEqual([
			{
				moduleId: 'agents.core',
				classId: owner.classId,
				outcome: 'erasable',
				rows: 3,
			},
			NOT_ERASABLE,
		]);
		expect(owner.eraseCalls).toEqual([]);
		expect(owner.subjectRows(ALPHA, SUBJECT)).toHaveLength(3);
		expect(await certificates()).toEqual([]);
		expect(result.certificatePath).toBeNull();
	});

	it('says the count is unknown for a class that cannot answer one', async () => {
		const { erasures, owner } = fixture({ count: false });

		const result = await erasures.run(request({ apply: false }));

		expect(result.classes).toEqual([
			{
				moduleId: 'agents.core',
				classId: owner.classId,
				outcome: 'erasable',
				rows: null,
			},
			NOT_ERASABLE,
		]);
	});

	/* AUDIT-ERASE-DRY-RUN: a class the deployment cannot erase is part of the
	   answer, because an operator who is told nothing about it would read the
	   plan as a complete one. */
	it('names a class that declares no erase operation as not erasable', async () => {
		const { erasures } = fixture();

		const plan = await erasures.run(request({ apply: false }));
		const applied = await erasures.run(request());

		for (const result of [plan, applied]) {
			expect(
				result.classes.find(
					(entry) => entry.classId === 'documents.core.documents',
				),
			).toEqual(NOT_ERASABLE);
		}
		const certificate = JSON.parse(
			await readFile(
				resolve(operator.allowed, (await certificates())[0]!),
				'utf8',
			),
		) as ErasureCertificate;
		expect(certificate.totals.notErasable).toBe(1);
		expect(certificate.classes.map((entry) => entry.classId)).toEqual([
			'agents.core.runs',
			'documents.core.documents',
		]);
	});
});

describe('AUDIT-ERASE-APPLY', () => {
	it('removes the subject from the declaring class and writes the certificate', async () => {
		const { owner, erasures } = fixture();

		const result = await erasures.run(request());

		expect(owner.subjectRows(ALPHA, SUBJECT)).toEqual([]);
		/* Another subject of the same workspace and the same subject in another
		   workspace are untouched. */
		expect(owner.subjectRows(ALPHA, OTHER)).toHaveLength(2);
		expect(owner.subjectRows(BETA, SUBJECT)).toHaveLength(4);
		expect(result.classes).toEqual([
			{
				moduleId: 'agents.core',
				classId: owner.classId,
				outcome: 'erased',
				rows: 3,
			},
			NOT_ERASABLE,
		]);
		expect(result.complete).toBe(true);

		const files = await certificates();
		expect(files).toHaveLength(1);
		const certificate = JSON.parse(
			await readFile(resolve(operator.allowed, files[0]!), 'utf8'),
		) as ErasureCertificate;
		expect({
			workspace: certificate.workspace.slug,
			subject: certificate.subject,
			classes: certificate.classes,
			totals: certificate.totals,
			complete: certificate.complete,
			operator: certificate.operator,
		}).toEqual({
			workspace: 'alpha',
			subject: SUBJECT,
			classes: [
				{
					moduleId: 'agents.core',
					classId: owner.classId,
					outcome: 'erased',
					rows: 3,
				},
				NOT_ERASABLE,
			],
			totals: { classes: 2, rows: 3, notErasable: 1 },
			complete: true,
			operator: 'cli:ada',
		});
		expect(certificate.completedAt).toBe(new Date(NOW).toISOString());
	});

	it('writes an audit event before and after the run', async () => {
		const { erasures } = fixture();

		await erasures.run(request());

		const actions = (await shared.repository.listAuditEvents(ALPHA, 20))
			.map((event) => event.action)
			.filter((action) =>
				[
					AUDIT_EVENT_ACTIONS.erasureStarted,
					AUDIT_EVENT_ACTIONS.erasureCompleted,
				].includes(action as never),
			);
		expect(actions.sort()).toEqual(
			[
				AUDIT_EVENT_ACTIONS.erasureCompleted,
				AUDIT_EVENT_ACTIONS.erasureStarted,
			].sort(),
		);
	});

	it('records a failing class on the certificate and keeps the others', async () => {
		const { owner, erasures } = fixture();
		owner.failErase = true;

		const result = await erasures.run(request());

		expect(result.classes[0]?.failure).toContain('owner erase is broken');
		expect(result.classes[0]?.outcome).toBe('failed');
		expect(result.complete).toBe(false);
		expect(result.certificatePath).not.toBeNull();
	});

	/* The erase operation reaches the run from the data class declaration or
	   from the adapter, and a class resolved either way behaves the same. */
	it('erases through the audit.erasure.v1 adapter for a class that registered there', async () => {
		const { owner, erasures } = fixture({ route: 'capability' });

		const result = await erasures.run(request());

		expect(owner.subjectRows(ALPHA, SUBJECT)).toEqual([]);
		expect(result.classes[0]).toEqual({
			moduleId: 'agents.core',
			classId: owner.classId,
			outcome: 'erased',
			rows: 3,
		});
	});

	it('records a truncated class and marks the run partial', async () => {
		const { owner, erasures } = fixture();
		owner.eraseTruncated = true;

		const record = await erasures.perform(
			await shared.repository.startErasureRun({
				tenantId: ALPHA,
				subject: SUBJECT,
				subjectMarker: erasureSubjectMarker(ALPHA, SUBJECT),
				requestedBy: 'cli:ada',
				outputDirectory: operator.allowed,
				dryRun: false,
				destroyKey: false,
				workspaceSlug: 'alpha',
				workspaceName: 'Alpha',
				startedAt: NOW,
			}),
		);

		expect(record.status).toBe('partial');
		expect(record.outcome?.[0]).toMatchObject({
			classId: owner.classId,
			outcome: 'erased',
			truncated: true,
		});
	});
});

describe('AUDIT-HOLD-BLOCKS-ERASE', () => {
	it('refuses the plan and the run with the stable code and writes nothing', async () => {
		const { owner, holds, erasures } = fixture();
		await holds.place(ALPHA, 'account-ada', {
			scopeKind: 'account',
			accountId: SUBJECT,
			reason: 'Pending litigation.',
		});

		await expect(erasures.run(request({ apply: false }))).rejects.toMatchObject(
			{ code: AUDIT_REASONS.holdActive },
		);
		await expect(erasures.run(request())).rejects.toMatchObject({
			code: AUDIT_REASONS.holdActive,
		});
		expect(owner.eraseCalls).toEqual([]);
		expect(owner.subjectRows(ALPHA, SUBJECT)).toHaveLength(3);
		expect(await certificates()).toEqual([]);
	});

	it('lets an erasure of another subject through', async () => {
		const { owner, holds, erasures } = fixture();
		await holds.place(ALPHA, 'account-ada', {
			scopeKind: 'account',
			accountId: OTHER,
			reason: 'Pending litigation.',
		});

		await erasures.run(request());

		expect(owner.subjectRows(ALPHA, SUBJECT)).toEqual([]);
		expect(owner.subjectRows(ALPHA, OTHER)).toHaveLength(2);
	});
});

describe('AUDIT-ERASE-KEY-DESTROYED', () => {
	it('makes the sealed fields unreadable for ever while the chain still verifies', async () => {
		const { erasures } = fixture();
		/* A sealed event: the actor, the subject and the details travel under the
		   subject's own data key. */
		await shared.repository.appendAuditEvent({
			tenantId: ALPHA,
			actorId: SUBJECT,
			action: AUDIT_EVENT_ACTIONS.retentionSet,
			subjectType: 'data-class',
			subjectId: 'agents.core.runs',
			metadata: { mode: 'days', days: 30, email: 'bob@example.com' },
			occurredAt: NOW,
			subjectAccountId: SUBJECT,
		});
		const before = await shared.repository.listAuditEvents(ALPHA, 10);
		expect(before[0]?.sealed).toBe(true);
		expect(before[0]?.readable).toBe(true);
		expect(before[0]?.actorId).toBe(SUBJECT);
		expect(before[0]?.metadata).toMatchObject({ email: 'bob@example.com' });

		const seals = new AuditSealService({
			repository: shared.repository,
			signer: createAnchorSigner(Buffer.alloc(32, 0x41)),
			environment: operator.environment,
			workspaceRoot: operator.workspaceRoot,
			now: () => NOW,
		});
		await seals.seal({
			tenantId: ALPHA,
			outputDirectory: operator.allowed,
			sealedBy: 'cli:ada',
			apply: true,
		});

		const result = await erasures.run(request({ destroyKey: true }));

		expect(result.subjectKey?.state).toBe('destroyed');
		expect(result.subjectKey?.subject).toBeNull();
		const after = await shared.repository.listAuditEvents(ALPHA, 20);
		const sealedEvent = after.find((event) => event.sequence === 1);
		expect({
			sealed: sealedEvent?.sealed,
			readable: sealedEvent?.readable,
			actorId: sealedEvent?.actorId,
			metadata: sealedEvent?.metadata,
		}).toEqual({
			sealed: true,
			readable: false,
			actorId: AUDIT_SEALED_MARKER,
			metadata: {},
		});

		const report = await seals.verify({
			tenantId: ALPHA,
			inputDirectory: operator.allowed,
		});
		expect({ ok: report.ok, failures: report.chain.failures }).toEqual({
			ok: true,
			failures: [],
		});
		/* The subject key is a tombstone: a later run finds nothing to destroy
		   and the events stay unreadable. */
		expect(await shared.repository.getSubjectKey(ALPHA, SUBJECT)).toBeNull();
		expect(
			await shared.repository.getSubjectKeyByMarker(
				ALPHA,
				erasureSubjectMarker(ALPHA, SUBJECT),
			),
		).toMatchObject({ state: 'destroyed', subject: null });
	});

	/* A second run must not seal its own opening event under a fresh key: a new
	   key for a destroyed subject puts the account back in the clear in exactly
	   the events the destruction made unreadable. */
	it('never gives a destroyed subject a second key', async () => {
		const { clock, erasures } = fixture();
		await shared.repository.appendAuditEvent({
			tenantId: ALPHA,
			actorId: SUBJECT,
			action: AUDIT_EVENT_ACTIONS.retentionSet,
			subjectType: 'data-class',
			subjectId: 'agents.core.runs',
			metadata: { email: 'bob@example.com' },
			occurredAt: NOW,
			subjectAccountId: SUBJECT,
		});
		await erasures.run(request({ destroyKey: true }));
		clock.now = NOW + 1_000;

		const second = await erasures.run(request({ destroyKey: true }));

		expect(second.subjectKey?.state).toBe('destroyed');
		const keys = await shared.repository.listSubjectKeys(ALPHA, 10);
		expect(keys).toHaveLength(1);
		expect(keys[0]?.subject).toBeNull();
		/* The second run names the subject by its marker. Nothing in the trail
		   reads back as the account: a second key would have made every event of
		   that run readable again. */
		const events = await shared.repository.listAuditEvents(ALPHA, 50);
		const marker = erasureSubjectMarker(ALPHA, SUBJECT);
		expect(events.some((event) => event.subjectId === marker)).toBe(true);
		expect(events.some((event) => event.subjectId === SUBJECT)).toBe(false);
		expect(events.some((event) => event.actorId === SUBJECT)).toBe(false);
	});

	/* The repository refuses too, so the guarantee does not rest on every caller
	   remembering to look: any writer naming a destroyed subject is refused
	   rather than quietly given a second key. */
	it('refuses an event that would give a destroyed subject a new key', async () => {
		const { erasures } = fixture();
		await shared.repository.appendAuditEvent({
			tenantId: ALPHA,
			actorId: SUBJECT,
			action: AUDIT_EVENT_ACTIONS.retentionSet,
			subjectType: 'data-class',
			subjectId: 'agents.core.runs',
			metadata: {},
			occurredAt: NOW,
			subjectAccountId: SUBJECT,
		});
		await erasures.run(request({ destroyKey: true }));

		await expect(
			shared.repository.appendAuditEvent({
				tenantId: ALPHA,
				actorId: SUBJECT,
				action: AUDIT_EVENT_ACTIONS.retentionSet,
				subjectType: 'data-class',
				subjectId: 'agents.core.runs',
				metadata: {},
				occurredAt: NOW + 1,
				subjectAccountId: SUBJECT,
			}),
		).rejects.toMatchObject({ code: 'SUBJECT_KEY_DESTROYED' });
		expect(await shared.repository.listSubjectKeys(ALPHA, 10)).toHaveLength(1);
	});

	it('leaves an event with no subject in the clear', async () => {
		fixture();
		await shared.repository.appendAuditEvent({
			tenantId: ALPHA,
			actorId: 'audit.core',
			action: AUDIT_EVENT_ACTIONS.retentionSweep,
			subjectType: 'data-class',
			subjectId: 'agents.core.runs',
			metadata: { classId: 'agents.core.runs' },
			occurredAt: NOW,
		});

		const [event] = await shared.repository.listAuditEvents(ALPHA, 10);

		expect([event?.sealed, event?.actorId, event?.subjectKeyId]).toEqual([
			false,
			'audit.core',
			null,
		]);
	});
});

describe('audit.erasure.v1', () => {
	it('refuses a registration after the registry is sealed', () => {
		const { owner, registry } = fixture();

		expect(() => registry.register(owner.erasureEntry())).toThrow(
			/after the platform started/,
		);
	});

	/* The adapter is for a module that composes after audit.core. A class whose
	   declaration already carries an erase is never asked twice. */
	it('prefers the declaration over a registration for the same class', async () => {
		const owner = new FakeOwnerModule(
			'agents.core',
			'runs',
			rows(ALPHA, SUBJECT, 1),
		);
		const shadow = new FakeOwnerModule(
			'agents.core',
			'runs',
			rows(ALPHA, SUBJECT, 1),
		);
		const dataClasses = createDataClassRegistry();
		dataClasses.declare(owner.moduleId, [owner.declaration()]);
		dataClasses.seal();
		const registry = createErasureRegistry();
		registry.register(shadow.erasureEntry());
		registry.seal();
		const erasures = new AuditErasureService({
			repository: shared.repository,
			holds: new AuditHoldService(shared.repository, () => NOW),
			dataClasses,
			adapter: registry,
			environment: operator.environment,
			workspaceRoot: operator.workspaceRoot,
			now: () => NOW,
		});

		await erasures.run(request());

		expect(owner.eraseCalls.length).toBeGreaterThan(0);
		expect(shadow.eraseCalls).toEqual([]);
	});

	it('refuses a class another module owns and a duplicate registration', () => {
		const registry = createErasureRegistry();
		const owner = new FakeOwnerModule('agents.core', 'runs');
		registry.register(owner.erasureEntry());

		expect(() => registry.register(owner.erasureEntry())).toThrow(
			/registered an erase operation twice/,
		);
		expect(() =>
			registry.register({
				moduleId: 'agents.core',
				classId: 'workflows.core.runs',
				erase: async () => ({ removed: 0 }),
			}),
		).toThrow(/not one of its class ids/);
	});
});

describe('erasure requests', () => {
	/* A plan is a request the platform answers, so the row exists before the
	   answer. One nobody answers must not sit in the ledger for ever: the
	   routing read pages through it on every interval. */
	it('expires a request no platform answered within a day', async () => {
		const { owner, erasures } = fixture();
		await shared.repository.startErasureRun({
			tenantId: ALPHA,
			subject: SUBJECT,
			subjectMarker: erasureSubjectMarker(ALPHA, SUBJECT),
			requestedBy: 'cli:ada',
			outputDirectory: operator.allowed,
			dryRun: true,
			destroyKey: false,
			workspaceSlug: 'alpha',
			workspaceName: 'Alpha',
			startedAt: NOW - ERASURE_REQUEST_TTL_MS - 1,
		});

		const pass = await erasures.tick();

		expect({ expired: pass.expired, completed: pass.completed }).toEqual({
			expired: 1,
			completed: 0,
		});
		const [run] = await shared.repository.listErasureRuns(ALPHA, 10);
		expect([run?.status, run?.reason]).toEqual([
			'failed',
			AUDIT_REASONS.erasureRequestExpired,
		]);
		expect(owner.eraseCalls).toEqual([]);
	});

	it('performs a request that is still inside the window', async () => {
		const { owner, erasures } = fixture();
		await shared.repository.startErasureRun({
			tenantId: ALPHA,
			subject: SUBJECT,
			subjectMarker: erasureSubjectMarker(ALPHA, SUBJECT),
			requestedBy: 'cli:ada',
			outputDirectory: operator.allowed,
			dryRun: false,
			destroyKey: false,
			workspaceSlug: 'alpha',
			workspaceName: 'Alpha',
			startedAt: NOW - ERASURE_REQUEST_TTL_MS + 1,
		});

		const pass = await erasures.tick();

		expect({ expired: pass.expired, completed: pass.completed }).toEqual({
			expired: 0,
			completed: 1,
		});
		expect(owner.subjectRows(ALPHA, SUBJECT)).toEqual([]);
	});
});
