import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';
import { createHarness, publicResolver } from './support/harness.ts';

const TENANT = 'tenant-webhooks';
const RESOLVER = publicResolver({
	'hooks.example': '93.184.216.34',
	'other.example': '93.184.216.35',
	'sneaky.example': '10.0.0.7',
});

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

function harness(allowlist = '') {
	return createHarness({
		repository: shared.repository,
		resolve: RESOLVER,
		allowlist,
	});
}

const INPUT = {
	name: 'Ops receiver',
	url: 'https://hooks.example/receiver',
	events: ['agent-run-failed', 'workflow-run-failed'],
} as const;

describe('notifications webhook subscriptions', () => {
	it('NOTIFICATIONS-WEBHOOK-CREATE returns the secret once and exposes only the fingerprint afterwards', async () => {
		const { webhooks } = harness();
		const created = await webhooks.create(TENANT, 'account-owner', INPUT);

		expect(created.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		expect(created.subscription.status).toBe('active');
		expect(created.subscription.events).toEqual([
			'agent-run-failed',
			'workflow-run-failed',
		]);
		expect(created.subscription.secretFingerprint).toHaveLength(32);
		expect(created.subscription).not.toHaveProperty('secret');

		const listed = await webhooks.list(TENANT);
		expect(listed).toHaveLength(1);
		expect(listed[0]).not.toHaveProperty('secret');
		expect(JSON.stringify(listed)).not.toContain(created.secret);
		expect(listed[0]?.secretFingerprint).toBe(
			created.subscription.secretFingerprint,
		);
	});

	it('NOTIFICATIONS-WEBHOOK-DUPLICATE answers a stable conflict and leaves the first subscription alone', async () => {
		const { webhooks } = harness();
		const first = await webhooks.create(TENANT, 'account-owner', INPUT);

		await expect(
			webhooks.create(TENANT, 'account-owner', {
				...INPUT,
				name: '  ops RECEIVER  ',
				url: 'https://other.example/receiver',
			}),
		).rejects.toMatchObject({
			code: 'SUBSCRIPTION_NAME_CONFLICT',
			status: 409,
		});

		const listed = await webhooks.list(TENANT);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.url).toBe(first.subscription.url);
	});

	it('NOTIFICATIONS-WEBHOOK-DUPLICATE also rejects renaming onto a taken name', async () => {
		const { webhooks } = harness();
		await webhooks.create(TENANT, 'account-owner', INPUT);
		const second = await webhooks.create(TENANT, 'account-owner', {
			...INPUT,
			name: 'Billing receiver',
		});

		await expect(
			webhooks.update(TENANT, second.subscription.id, {
				...INPUT,
				name: 'ops receiver',
			}),
		).rejects.toMatchObject({ code: 'SUBSCRIPTION_NAME_CONFLICT' });
		expect((await webhooks.get(TENANT, second.subscription.id)).name).toBe(
			'Billing receiver',
		);
	});

	it('NOTIFICATIONS-EGRESS refuses a non-https scheme, an address literal and a private resolution before any write', async () => {
		const { webhooks } = harness();
		for (const [url, code] of [
			['http://hooks.example/receiver', 'WEBHOOK_URL_BLOCKED'],
			['https://127.0.0.1/receiver', 'WEBHOOK_URL_BLOCKED'],
			['https://[::1]/receiver', 'WEBHOOK_URL_BLOCKED'],
			['https://localhost/receiver', 'WEBHOOK_URL_BLOCKED'],
			['https://sneaky.example/receiver', 'WEBHOOK_HOST_RESOLVES_PRIVATE'],
			['https://unknown.example/receiver', 'WEBHOOK_HOST_UNRESOLVED'],
		] as const) {
			await expect(
				webhooks.create(TENANT, 'account-owner', { ...INPUT, url }),
			).rejects.toMatchObject({ code, status: 400 });
		}
		expect(await webhooks.list(TENANT)).toHaveLength(0);
	});

	it('NOTIFICATIONS-EGRESS refuses a host outside a non-empty platform allowlist', async () => {
		const allowed = harness('hooks.example');
		await allowed.webhooks.create(TENANT, 'account-owner', INPUT);

		await expect(
			allowed.webhooks.create(TENANT, 'account-owner', {
				...INPUT,
				name: 'Other receiver',
				url: 'https://other.example/receiver',
			}),
		).rejects.toMatchObject({
			code: 'WEBHOOK_HOST_NOT_ALLOWLISTED',
			status: 400,
		});
		expect(await allowed.webhooks.list(TENANT)).toHaveLength(1);
	});

	it('NOTIFICATIONS-EGRESS validates a changed URL on update too', async () => {
		const { webhooks } = harness();
		const created = await webhooks.create(TENANT, 'account-owner', INPUT);
		await expect(
			webhooks.update(TENANT, created.subscription.id, {
				...INPUT,
				url: 'https://sneaky.example/receiver',
			}),
		).rejects.toMatchObject({ code: 'WEBHOOK_HOST_RESOLVES_PRIVATE' });
		expect((await webhooks.get(TENANT, created.subscription.id)).url).toBe(
			created.subscription.url,
		);
	});

	it('NOTIFICATIONS-ROTATE issues a new secret once and moves the fingerprint', async () => {
		const { webhooks } = harness();
		const created = await webhooks.create(TENANT, 'account-owner', INPUT);
		const rotated = await webhooks.rotateSecret(
			TENANT,
			created.subscription.id,
		);

		expect(rotated.secret).not.toBe(created.secret);
		expect(rotated.subscription.secretFingerprint).not.toBe(
			created.subscription.secretFingerprint,
		);
		expect(rotated.subscription.secretRevision).toBe(2);
		const listed = await webhooks.list(TENANT);
		expect(JSON.stringify(listed)).not.toContain(rotated.secret);
		expect(listed[0]?.secretFingerprint).toBe(
			rotated.subscription.secretFingerprint,
		);
	});

	it('pauses, resumes and refuses an impossible transition', async () => {
		const { webhooks } = harness();
		const created = await webhooks.create(TENANT, 'account-owner', INPUT);
		const id = created.subscription.id;

		expect((await webhooks.pause(TENANT, id)).status).toBe('paused');
		expect((await webhooks.pause(TENANT, id)).status).toBe('paused');
		expect((await webhooks.resume(TENANT, id)).status).toBe('active');
		await expect(webhooks.delete(TENANT, id)).rejects.toMatchObject({
			code: 'SUBSCRIPTION_NOT_DISABLED',
			status: 409,
		});
	});

	it('NOTIFICATIONS-DISABLE-DELETE drops the pending queue, keeps the ledger and then deletes', async () => {
		const { webhooks, publisher, deliveries } = harness();
		const created = await webhooks.create(TENANT, 'account-owner', INPUT);
		const id = created.subscription.id;
		for (const sourceRef of ['run-finished', 'run-waiting']) {
			await publisher.publish({
				tenantId: TENANT,
				kind: 'agent-run-failed',
				sourceModule: 'agents.core',
				sourceRef,
				title: `Event ${sourceRef}`,
				recipients: [],
			});
		}
		const finished = (await deliveries.list(TENANT, {})).find(
			(entry) => entry.sourceRef === 'run-finished',
		)!;
		await shared.repository.completeDelivery({
			tenantId: TENANT,
			id: finished.id,
			status: 'succeeded',
			completedAt: Date.now(),
			responseStatus: 200,
			errorClass: null,
		});

		expect((await webhooks.disable(TENANT, id)).status).toBe('disabled');

		/* The waiting attempt is gone and the completed one is untouched. */
		expect(
			(await deliveries.list(TENANT, {})).map((entry) => [
				entry.sourceRef,
				entry.status,
			]),
		).toEqual([['run-finished', 'succeeded']]);

		await webhooks.delete(TENANT, id);
		expect(await webhooks.list(TENANT)).toHaveLength(0);
		expect(
			(await deliveries.list(TENANT, {})).map((entry) => entry.sourceRef),
		).toEqual(['run-finished']);
	});

	it('NOTIFICATIONS-DISABLE-DELETE refuses to delete an active or a paused subscription', async () => {
		const { webhooks } = harness();
		const created = await webhooks.create(TENANT, 'account-owner', INPUT);
		const id = created.subscription.id;

		await expect(webhooks.delete(TENANT, id)).rejects.toMatchObject({
			code: 'SUBSCRIPTION_NOT_DISABLED',
			status: 409,
		});
		await webhooks.pause(TENANT, id);
		await expect(webhooks.delete(TENANT, id)).rejects.toMatchObject({
			code: 'SUBSCRIPTION_NOT_DISABLED',
			status: 409,
		});
		expect(await webhooks.list(TENANT)).toHaveLength(1);
	});

	it('NOTIFICATIONS-DISABLE-DELETE disables a paused subscription, repeats without effect and resumes it', async () => {
		const { webhooks, publisher, deliveries } = harness();
		const created = await webhooks.create(TENANT, 'account-owner', INPUT);
		const id = created.subscription.id;
		await webhooks.pause(TENANT, id);

		expect((await webhooks.disable(TENANT, id)).status).toBe('disabled');
		expect((await webhooks.disable(TENANT, id)).status).toBe('disabled');
		expect((await webhooks.resume(TENANT, id)).status).toBe('active');

		/* Active again, so a later event queues again. */
		await publisher.publish({
			tenantId: TENANT,
			kind: 'agent-run-failed',
			sourceModule: 'agents.core',
			sourceRef: 'run-after-resume',
			title: 'Event after resume',
			recipients: [],
		});
		expect(
			(await deliveries.list(TENANT, { status: 'pending' })).map(
				(entry) => entry.sourceRef,
			),
		).toEqual(['run-after-resume']);
	});

	it('answers not found for a subscription of another tenant', async () => {
		const { webhooks } = harness();
		const created = await webhooks.create(TENANT, 'account-owner', INPUT);
		await expect(
			webhooks.get('tenant-other', created.subscription.id),
		).rejects.toMatchObject({ code: 'SUBSCRIPTION_NOT_FOUND', status: 404 });
	});

	/* Extending the kind list must not invalidate a selection saved under the
	   shorter one: the kinds a subscription already names are still accepted and
	   still stored in the declared order. */
	it('keeps the event selection of a subscription saved before the approval kinds', async () => {
		const { webhooks } = harness();
		const legacy = [
			'agent-run-completed',
			'agent-run-failed',
			'workflow-run-completed',
			'workflow-run-failed',
			'webhook-dead-letter',
		] as const;
		const created = await webhooks.create(TENANT, 'account-owner', {
			...INPUT,
			events: legacy,
		});
		expect(created.subscription.events).toEqual([...legacy]);

		const renamed = await webhooks.update(TENANT, created.subscription.id, {
			...INPUT,
			name: 'Ops receiver renamed',
			events: created.subscription.events,
		});
		expect(renamed.events).toEqual([...legacy]);
		expect(
			(await webhooks.get(TENANT, created.subscription.id)).events,
		).toEqual([...legacy]);
	});

	it('rejects an empty or unknown event selection', async () => {
		const { webhooks } = harness();
		for (const events of [[], ['not-a-kind']]) {
			await expect(
				webhooks.create(TENANT, 'account-owner', { ...INPUT, events }),
			).rejects.toMatchObject({ code: 'INVALID_INPUT' });
		}
	});
});
