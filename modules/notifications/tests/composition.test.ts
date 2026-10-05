import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseProviderRequest } from '@flowdular/database';
import type { MailMessage, MailPort } from '@flowdular/server';
import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	NOTIFICATIONS_PUBLISH_CAPABILITY,
	type NotificationPublisher,
} from '../src/domain/publish.ts';
import { createServerComposition } from '../src/platform.ts';
import { NotificationsService } from '../src/services/notifications-service.ts';
import {
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';
import { developmentMailPort } from './support/harness.ts';

const TENANT = 'tenant-roles';
const ADA = {
	accountId: 'account-ada',
	email: 'ada@example.com',
	scopes: ['notifications.inbox.read'],
};
/* The poll setting is read in seconds; this answers a 20 ms cadence, so a
   loop that runs at all runs many times inside each wait below. */
const POLL_SECONDS = 0.02;

let shared: NotificationsTestDatabase;

beforeAll(async () => {
	shared = await openNotificationsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

/** A development port whose sends can be held open, to keep a pass in flight. */
function heldMail() {
	const port = developmentMailPort();
	let gate: Promise<void> | undefined;
	let open = (): void => undefined;
	let sends = 0;
	const mail: MailPort = {
		adapter: port.adapter,
		configured: port.configured,
		get outbox() {
			return port.outbox;
		},
		async send(message: MailMessage) {
			sends += 1;
			if (gate) await gate;
			await port.send(message);
		},
	};
	return {
		mail,
		sends: () => sends,
		hold() {
			gate = new Promise((resolve) => {
				open = resolve;
			});
		},
		release() {
			gate = undefined;
			open();
		},
	};
}

/* One process's composition over the shared database, wired the way the
   platform wires it; web and worker roles are two of these. */
function composed(mail: MailPort = developmentMailPort()) {
	const registered = new Map<string, unknown>();
	const reads: string[] = [];
	const purposes: string[] = [];
	const context = {
		environment: { NODE_ENV: 'test' },
		workspaceRoot: process.cwd(),
		auth: {
			service: async () => ({
				listTenantMembers: async () => [{ ...ADA, status: 'active' }],
			}),
		},
		settings: {
			prime: async () => undefined,
			get: (_tenantId: string, _moduleId: string, key: string) => {
				reads.push(key);
				if (key === 'pollIntervalSeconds') return POLL_SECONDS;
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
		mail,
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
		mail,
		reads,
		purposes,
		publisher: () =>
			registered.get(NOTIFICATIONS_PUBLISH_CAPABILITY) as NotificationPublisher,
	};
}

async function startWorker(
	composition: PlatformServerComposition,
): Promise<void> {
	if (!composition.startWorker) throw new Error('startWorker is missing.');
	await composition.startWorker();
}

async function publish(publisher: NotificationPublisher, sourceRef: string) {
	return publisher.publish({
		tenantId: TENANT,
		kind: 'agent-run-failed',
		sourceModule: 'agents.core',
		sourceRef,
		title: 'Nightly reconciliation failed',
		recipients: [ADA.accountId],
	});
}

async function deliveryStatus(id: string | undefined) {
	return (await shared.repository.getDelivery(TENANT, id ?? ''))?.status;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(check: () => boolean | Promise<boolean>) {
	for (let attempt = 0; attempt < 150; attempt += 1) {
		if (await check()) return true;
		await wait(20);
	}
	return false;
}

describe('notifications.core web and worker roles', () => {
	it('NOTIFICATIONS-WEB-WORKER-ROLE persists a web publish and leaves delivery to the worker', async () => {
		await new NotificationsService(shared.repository).saveEmailDelivery(
			TENANT,
			ADA.accountId,
			true,
		);
		const web = composed();
		const worker = composed();
		try {
			web.composition.start?.();
			const published = await publish(web.publisher(), 'run-web');
			expect(published.inboxItemIds).toHaveLength(1);
			expect(published.deliveryIds).toHaveLength(1);

			await wait(200);
			expect(web.mail.outbox).toEqual([]);
			expect(web.reads).not.toContain('pollIntervalSeconds');
			expect(await deliveryStatus(published.deliveryIds[0])).toBe('pending');

			worker.composition.start?.();
			await startWorker(worker.composition);
			expect(await settle(() => worker.mail.outbox.length > 0)).toBe(true);
			await wait(150);
			expect(worker.mail.outbox).toHaveLength(1);
			expect(worker.mail.outbox[0]?.to).toEqual([ADA.email]);
			expect(web.mail.outbox).toEqual([]);
			expect(await deliveryStatus(published.deliveryIds[0])).toBe('succeeded');
		} finally {
			for (const role of [web, worker]) {
				await role.composition.stop?.();
				await role.composition.dispose?.();
			}
		}
	});

	it('NOTIFICATIONS-WORKER-DRAIN drains a claimed delivery on stop, takes no work after it, and restarts', async () => {
		await new NotificationsService(shared.repository).saveEmailDelivery(
			TENANT,
			ADA.accountId,
			true,
		);
		const held = heldMail();
		const worker = composed(held.mail);
		try {
			const first = await publish(worker.publisher(), 'run-first');
			held.hold();
			await startWorker(worker.composition);
			expect(await settle(() => held.sends() === 1)).toBe(true);

			let stopped = false;
			const stopping = Promise.resolve(worker.composition.stop?.()).then(() => {
				stopped = true;
			});
			await wait(100);
			expect(stopped).toBe(false);
			held.release();
			await stopping;
			expect(held.mail.outbox).toHaveLength(1);
			expect(await deliveryStatus(first.deliveryIds[0])).toBe('succeeded');

			const second = await publish(worker.publisher(), 'run-second');
			await wait(200);
			expect(held.sends()).toBe(1);
			expect(await deliveryStatus(second.deliveryIds[0])).toBe('pending');

			await startWorker(worker.composition);
			expect(await settle(() => held.mail.outbox.length === 2)).toBe(true);
			await wait(100);
			expect(held.sends()).toBe(2);
			expect(await deliveryStatus(second.deliveryIds[0])).toBe('succeeded');
		} finally {
			held.release();
			await worker.composition.stop?.();
			await worker.composition.dispose?.();
		}
	});

	it('NOTIFICATIONS-WORKER-DRAIN stops cleanly when startWorker never ran', async () => {
		const web = composed();
		web.composition.start?.();
		await wait(50);
		await web.composition.stop?.();
		await web.composition.dispose?.();
		expect(web.purposes).toEqual([]);
		expect(web.reads).toEqual([]);
	});
});
