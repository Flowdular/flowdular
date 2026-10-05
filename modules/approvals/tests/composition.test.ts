import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import type {
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import { PLATFORM_SETTINGS_TENANT } from '@flowdular/kernel';
import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	APPROVALS_REQUESTS_CAPABILITY,
	type ApprovalsRequests,
} from '../src/domain/capability.ts';
import { createServerComposition } from '../src/platform.ts';
import {
	NOTIFICATIONS_PUBLISH_CAPABILITY,
	type NotificationPublishInput,
} from '../src/services/notifications.ts';
import {
	openApprovalsTestDatabase,
	type ApprovalsTestDatabase,
} from './support/database.ts';
import {
	createHarness,
	DAY_MS,
	member,
	OWNER_ROLE,
} from './support/harness.ts';

const TENANT = 'tenant-roles';
const REQUESTER = 'account-requester';
const MEMBERS = [member(REQUESTER), member('account-ada')];
/* The interval setting is read in minutes; this answers a 30 ms cadence, so a
   loop that runs at all runs many times inside each wait below. */
const INTERVAL_MINUTES = 0.0005;

let shared: ApprovalsTestDatabase;

beforeAll(async () => {
	shared = await openApprovalsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

interface ComposedOptions {
	/** Runs inside the platform-tenant prime the interval read waits on. */
	readonly primePlatform?: () => Promise<void>;
	/** Runs inside the notification an expiry publishes after it commits. */
	readonly published?: () => Promise<void>;
}

/* One process's composition over the shared database, wired the way the
   platform wires it; web and worker roles are two of these. */
function composed(options: ComposedOptions = {}) {
	const registered = new Map<string, unknown>();
	const reads: string[] = [];
	const purposes: string[] = [];
	const publishes: NotificationPublishInput[] = [];
	registered.set(NOTIFICATIONS_PUBLISH_CAPABILITY, {
		publish: async (input: NotificationPublishInput) => {
			publishes.push(input);
			await options.published?.();
			return { inboxItemIds: [], deliveryIds: [] };
		},
	});
	const records = MEMBERS.map((entry) => ({
		accountId: entry.accountId,
		role: entry.roleKey,
		status: 'active',
		membershipStatus: 'active',
		scopes: entry.scopes,
	}));
	const context = {
		environment: { NODE_ENV: 'test' },
		workspaceRoot: process.cwd(),
		auth: {
			service: async () => ({
				listTenantMembers: async () => records,
				findTenantMember: async (_tenantId: string, accountId: string) =>
					records.find((entry) => entry.accountId === accountId) ?? null,
			}),
		},
		settings: {
			prime: async (tenantId: string) => {
				if (tenantId === PLATFORM_SETTINGS_TENANT) {
					await options.primePlatform?.();
				}
			},
			get: (_tenantId: string, _moduleId: string, key: string) => {
				reads.push(key);
				if (key === 'expiryIntervalMinutes') return INTERVAL_MINUTES;
				if (key === 'defaultExpiryDays') return 7;
				throw new Error(`No value for ${key}.`);
			},
		},
		databases: {
			acquire: (request: DatabaseProviderRequest) => {
				purposes.push(request.purpose);
				return shared.databases.acquire(request);
			},
			dispose: async () => undefined,
		},
		dataClasses: { declare: () => undefined },
		capabilities: {
			register: (id: string, value: unknown) => registered.set(id, value),
			get: (id: string) => registered.get(id) ?? null,
		},
	};
	const composition = createServerComposition(
		context as unknown as PlatformServerContext,
	);
	return {
		composition,
		reads,
		purposes,
		publishes,
		requests: () =>
			registered.get(APPROVALS_REQUESTS_CAPABILITY) as ApprovalsRequests,
	};
}

async function startWorker(
	composition: PlatformServerComposition,
): Promise<void> {
	if (!composition.startWorker) throw new Error('startWorker is missing.');
	await composition.startWorker();
}

/* Opened a month ago with the seven day default, so it is due now. */
async function openDue(subjectRef: string) {
	const { service } = createHarness({
		repository: shared.repository,
		members: [...MEMBERS],
		now: () => Date.now() - 30 * DAY_MS,
	});
	return service.open({
		tenantId: TENANT,
		subjectModule: 'workflows.core',
		subjectRef,
		permission: 'workflows.runs.approve',
		action: 'approve',
		title: 'Approve the run',
		requesterAccountId: REQUESTER,
		requirement: { roleKey: OWNER_ROLE },
	});
}

async function status(id: string) {
	return (await shared.repository.get(TENANT, id))?.status;
}

function gate() {
	let open = (): void => undefined;
	const closed = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { closed, open };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(check: () => boolean | Promise<boolean>) {
	for (let attempt = 0; attempt < 150; attempt += 1) {
		if (await check()) return true;
		await wait(20);
	}
	return false;
}

describe('approvals.core web and worker roles', () => {
	it('APPROVALS-WEB-WORKER-ROLE serves requests in the web role and expires them only in the worker', async () => {
		const due = await openDue('run-due');
		const web = composed();
		const worker = composed();
		try {
			web.composition.start?.();
			expect((await web.requests().get(TENANT, due.id))?.status).toBe(
				'pending',
			);
			const opened = await web.requests().open({
				tenantId: TENANT,
				subjectModule: 'workflows.core',
				subjectRef: 'run-web',
				permission: 'workflows.runs.approve',
				action: 'approve',
				title: 'Approve the web run',
				requesterAccountId: REQUESTER,
				requirement: { roleKey: OWNER_ROLE },
			});

			await wait(200);
			expect(web.reads).not.toContain('expiryIntervalMinutes');
			expect(await status(due.id)).toBe('pending');

			worker.composition.start?.();
			await startWorker(worker.composition);
			expect(worker.reads).toContain('expiryIntervalMinutes');
			expect(
				await settle(async () => (await status(due.id)) === 'expired'),
			).toBe(true);
			expect(await status(opened.id)).toBe('pending');
		} finally {
			for (const role of [web, worker]) {
				await role.composition.stop?.();
				await role.composition.dispose?.();
			}
		}
	});

	it('APPROVALS-WEB-WORKER-ROLE holds worker readiness on the interval read and rejects when it fails', async () => {
		const due = await openDue('run-ready');
		let failing = true;
		const prime = gate();
		const worker = composed({
			primePlatform: async () => {
				await prime.closed;
				if (failing) throw new Error('Settings store unavailable.');
			},
		});
		try {
			let settled = false;
			const starting = startWorker(worker.composition).finally(() => {
				settled = true;
			});
			await wait(50);
			expect(settled).toBe(false);
			prime.open();
			await expect(starting).rejects.toThrow('Settings store unavailable.');
			await wait(100);
			expect(await status(due.id)).toBe('pending');

			failing = false;
			await startWorker(worker.composition);
			expect(
				await settle(async () => (await status(due.id)) === 'expired'),
			).toBe(true);
		} finally {
			prime.open();
			await worker.composition.stop?.();
			await worker.composition.dispose?.();
		}
	});

	it('APPROVALS-WORKER-DRAIN drains the expiry pass on stop, begins no pass after it, and restarts', async () => {
		const first = await openDue('run-first');
		const held = gate();
		let holding = true;
		const worker = composed({
			published: async () => {
				if (holding) await held.closed;
			},
		});
		try {
			await startWorker(worker.composition);
			expect(await settle(() => worker.publishes.length === 1)).toBe(true);

			let stopped = false;
			const stopping = Promise.resolve(worker.composition.stop?.()).then(() => {
				stopped = true;
			});
			await wait(100);
			expect(stopped).toBe(false);
			holding = false;
			held.open();
			await stopping;
			expect(await status(first.id)).toBe('expired');

			const second = await openDue('run-second');
			await wait(200);
			expect(await status(second.id)).toBe('pending');
			expect(worker.publishes).toHaveLength(1);

			await startWorker(worker.composition);
			expect(
				await settle(async () => (await status(second.id)) === 'expired'),
			).toBe(true);
		} finally {
			holding = false;
			held.open();
			await worker.composition.stop?.();
			await worker.composition.dispose?.();
		}
	});

	it('APPROVALS-WORKER-DRAIN stops cleanly when startWorker never ran', async () => {
		const web = composed();
		web.composition.start?.();
		await wait(50);
		await web.composition.stop?.();
		await web.composition.dispose?.();
		expect(web.purposes).toEqual([]);
		expect(web.reads).toEqual([]);
	});
});

/* Refuses the first background lease, which an open takes after its runtime
   lease, and counts the releases of every runtime lease handed out. */
function refuseFirstOpen(databases: DatabaseProvider) {
	const acquire = databases.acquire.bind(databases);
	const runtimeReleases: ReturnType<typeof vi.fn>[] = [];
	let refused = 0;
	const spy = vi
		.spyOn(databases, 'acquire')
		.mockImplementation(async (request) => {
			if (request.purpose === 'background' && refused === 0) {
				refused += 1;
				throw new Error('background pool unavailable');
			}
			const lease = await acquire(request);
			if (request.purpose === 'migration' || request.purpose === 'background')
				return lease;
			const release = vi.fn(() => lease.release());
			runtimeReleases.push(release);
			return { database: lease.database, release };
		});
	return {
		runtimeReleases,
		refused: () => refused,
		restore: () => spy.mockRestore(),
	};
}

describe('an approvals worker whose database open failed', () => {
	it('opens it again on the next startWorker of the same composition and released what the failed open held', async () => {
		const due = await openDue('run-reopen');
		const worker = composed();
		const refusal = refuseFirstOpen(shared.databases);
		try {
			await startWorker(worker.composition);
			await worker.composition.stop?.();
			expect(refusal.refused()).toBe(1);
			expect(refusal.runtimeReleases).toHaveLength(1);
			expect(refusal.runtimeReleases[0]).toHaveBeenCalledTimes(1);
			expect(await status(due.id)).toBe('pending');

			await startWorker(worker.composition);
			expect(
				await settle(async () => (await status(due.id)) === 'expired'),
			).toBe(true);
		} finally {
			refusal.restore();
			await worker.composition.stop?.();
			await worker.composition.dispose?.();
		}
	});
});
