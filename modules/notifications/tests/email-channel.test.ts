import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	createMailPort,
	mailConfigFromEnvironment,
	MailError,
	NO_MAIL,
	type MailErrorCode,
	type MailMessage,
	type MailPort,
} from '@flowdular/server';
import { emailDeliveryAttempt } from '../src/services/email-channel.ts';
import { TEST_SETTINGS, createHarness } from './support/harness.ts';
import {
	openNotificationsTestDatabase,
	type NotificationsTestDatabase,
} from './support/database.ts';

const TENANT = 'tenant-email';
const ADA = {
	accountId: 'account-ada',
	email: 'ada@example.com',
	scopes: ['notifications.inbox.read', 'notifications.deliveries.read'],
};
const BO = {
	accountId: 'account-bo',
	email: 'bo@example.com',
	scopes: ['notifications.inbox.read'],
};

let shared: NotificationsTestDatabase;
let clock = Date.UTC(2026, 0, 2, 9, 0, 0);

beforeAll(async () => {
	shared = await openNotificationsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
	clock = Date.UTC(2026, 0, 2, 9, 0, 0);
});

function harness(mail?: MailPort) {
	return createHarness({
		repository: shared.repository,
		now: () => clock,
		members: [ADA, BO],
		...(mail ? { mail } : {}),
	});
}

/** A composed transport that refuses every message it is handed. */
function refusingPort(code: MailErrorCode) {
	const attempted: MailMessage[] = [];
	const port: MailPort = {
		adapter: 'smtp',
		configured: true,
		outbox: NO_MAIL,
		async send(message) {
			attempted.push(message);
			throw new MailError(code, 'The transport refused the message.');
		},
	};
	return { attempted, port };
}

async function publish(
	publisher: ReturnType<typeof harness>['publisher'],
	sourceRef: string,
	recipients: readonly string[],
) {
	return publisher.publish({
		tenantId: TENANT,
		kind: 'agent-run-failed',
		sourceModule: 'agents.core',
		sourceRef,
		title: 'Nightly reconciliation failed',
		body: 'The <run> ended with 3 errors & 1 warning.',
		recipients,
	});
}

describe('notifications e-mail channel', () => {
	it('NOTIFICATIONS-EMAIL-CHANNEL mails an inbox item once the member asked for it', async () => {
		const { publisher, deliveries, inbox, mail, runner } = harness();
		await inbox.saveEmailDelivery(TENANT, ADA.accountId, true, clock);

		const published = await publish(publisher, 'run-1', [
			ADA.accountId,
			BO.accountId,
		]);
		/* Two members are addressed, one asked for mail. */
		expect(published.inboxItemIds).toHaveLength(2);
		expect(published.deliveryIds).toHaveLength(1);

		expect(await runner.tick()).toEqual({
			claimed: 1,
			performed: 1,
			failed: 0,
			claimLost: 0,
		});

		expect(mail.outbox).toHaveLength(1);
		const sent = mail.outbox[0]!;
		expect(sent.to).toEqual([ADA.email]);
		expect(sent.subject).toBe('Nightly reconciliation failed');
		expect(sent.text).toContain('The <run> ended with 3 errors & 1 warning.');
		/* The body is the member's own text; the HTML part must not let it open a
		   tag. */
		expect(sent.html).toContain('The &lt;run&gt; ended with 3 errors &amp; 1');
		expect(sent.headers).toEqual({
			'x-flowdular-notification': 'agent-run-failed',
			'content-language': 'en',
		});

		const [attempt] = await deliveries.list(TENANT, {});
		expect(attempt).toMatchObject({
			channel: 'email',
			subscriptionId: null,
			recipientAccountId: ADA.accountId,
			status: 'succeeded',
			attemptNumber: 1,
			errorClass: null,
		});
		/* The ledger holds a digest and a size; the body and the address stay out
		   of it, which is why a retry reads them again instead of replaying a
		   stored copy. */
		expect(attempt?.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(attempt)).not.toContain('ended with 3 errors');
		expect(JSON.stringify(attempt)).not.toContain(ADA.email);
	});

	it('queues nothing for a member who never asked for e-mail', async () => {
		const { publisher, mail, runner } = harness();

		const published = await publish(publisher, 'run-2', [ADA.accountId]);
		expect(published.deliveryIds).toEqual([]);

		expect(await runner.tick()).toEqual({
			claimed: 0,
			performed: 0,
			failed: 0,
			claimLost: 0,
		});
		expect(mail.outbox).toEqual([]);
	});

	/* The kind switch decides whether there is an item at all, so a kind turned
	   off cannot be mailed by turning e-mail on. */
	it('sends nothing for a kind the member disabled', async () => {
		const { publisher, inbox, mail, runner } = harness();
		await inbox.saveEmailDelivery(TENANT, ADA.accountId, true, clock);
		await inbox.savePreference(
			TENANT,
			ADA.accountId,
			'agent-run-failed',
			false,
			clock,
		);

		const published = await publish(publisher, 'run-3', [ADA.accountId]);
		expect(published.inboxItemIds).toEqual([]);
		expect(published.deliveryIds).toEqual([]);
		await runner.tick();

		expect(mail.outbox).toEqual([]);
	});

	it('publishes the same event twice without mailing it twice', async () => {
		const { publisher, inbox, mail, runner } = harness();
		await inbox.saveEmailDelivery(TENANT, ADA.accountId, true, clock);

		const first = await publish(publisher, 'run-4', [ADA.accountId]);
		const repeat = await publish(publisher, 'run-4', [ADA.accountId]);
		expect(repeat).toEqual(first);

		await runner.tick();
		await runner.tick();
		expect(mail.outbox).toHaveLength(1);
	});

	it('retries a refused message with the webhook backoff and dead-letters it in silence', async () => {
		const { port, attempted } = refusingPort('MAIL_DELIVERY_FAILED');
		const { publisher, deliveries, inbox, runner } = harness(port);
		await inbox.saveEmailDelivery(TENANT, ADA.accountId, true, clock);
		await publish(publisher, 'run-5', [ADA.accountId]);

		for (let pass = 1; pass <= TEST_SETTINGS.retryMaxAttempts; pass += 1) {
			await runner.tick();
			/* Each failure schedules the next attempt into the future, so time has
			   to move for the queue to offer it again. */
			clock += 6 * 60 * 60 * 1_000;
		}

		expect(attempted).toHaveLength(TEST_SETTINGS.retryMaxAttempts);
		const ledger = await deliveries.list(TENANT, {});
		expect(ledger).toHaveLength(TEST_SETTINGS.retryMaxAttempts);
		expect(ledger.map((entry) => entry.status)).toContain('dead-letter');
		expect(new Set(ledger.map((entry) => entry.errorClass))).toEqual(
			new Set(['network']),
		);
		/* A dead-lettered message must not become an inbox item: it would be
		   mailed again, fail again and dead-letter again under a new reference. */
		expect(
			await inbox.list(TENANT, ADA.accountId, { kind: 'webhook-dead-letter' }),
		).toEqual([]);
	});

	/* A title stored before the publication path kept it to one line would make
	   the port refuse the subject, every attempt, until the budget is gone. */
	it('mails a stored title that is not one line as one subject line', async () => {
		const { inbox, mail, deliveries, runner } = harness();
		await inbox.saveEmailDelivery(TENANT, ADA.accountId, true, clock);
		await shared.repository.appendInboxItems(
			TENANT,
			[
				{
					id: randomUUID(),
					tenantId: TENANT,
					recipientAccountId: ADA.accountId,
					kind: 'agent-run-failed',
					title: 'Nightly run failed\r\nBcc: everyone@example.com',
					body: 'Line one.\nLine two.',
					sourceModule: 'agents.core',
					sourceRef: 'run-stored',
					status: 'unread',
					readAt: null,
					createdAt: clock,
				},
			],
			(item) => emailDeliveryAttempt(item, clock),
		);

		await runner.tick();

		expect(mail.outbox).toHaveLength(1);
		const sent = mail.outbox[0]!;
		expect(sent.subject).toBe('Nightly run failed  Bcc: everyone@example.com');
		expect(sent.headers).toEqual({
			'x-flowdular-notification': 'agent-run-failed',
			'content-language': 'en',
		});
		/* The body keeps its own line breaks: only the subject is one line. */
		expect(sent.text).toContain('Line one.\nLine two.');
		expect(await deliveries.list(TENANT, {})).toEqual([
			expect.objectContaining({ status: 'succeeded' }),
		]);
	});

	/* The port refused these bytes, and it would refuse them on every later
	   attempt, so the budget is not spent proving that. */
	it('dead-letters a message the port refuses without retrying it', async () => {
		const { port, attempted } = refusingPort('MAIL_MESSAGE_REJECTED');
		const { publisher, deliveries, inbox, runner } = harness(port);
		await inbox.saveEmailDelivery(TENANT, ADA.accountId, true, clock);
		await publish(publisher, 'run-8', [ADA.accountId]);

		for (let pass = 1; pass <= TEST_SETTINGS.retryMaxAttempts; pass += 1) {
			await runner.tick();
			clock += 6 * 60 * 60 * 1_000;
		}

		expect(attempted).toHaveLength(1);
		expect(await deliveries.list(TENANT, {})).toEqual([
			expect.objectContaining({
				status: 'dead-letter',
				attemptNumber: 1,
				errorClass: 'mail-refused',
			}),
		]);
	});

	/* The workspace says which language its messages are written in, so a client
	   renders and reads one as that language. */
	it('sends the message under the workspace default locale', async () => {
		const { publisher, inbox, mail, runner } = createHarness({
			repository: shared.repository,
			now: () => clock,
			members: [ADA],
			locale: (tenantId) => (tenantId === TENANT ? 'pl' : 'en'),
		});
		await inbox.saveEmailDelivery(TENANT, ADA.accountId, true, clock);
		await publish(publisher, 'run-9', [ADA.accountId]);

		await runner.tick();

		expect(mail.outbox[0]).toMatchObject({
			locale: 'pl',
			headers: {
				'content-language': 'pl',
				'x-flowdular-notification': 'agent-run-failed',
			},
		});
	});

	it('records a refusal from an unconfigured deployment as a mail refusal', async () => {
		const { publisher, deliveries, inbox, runner } = harness(
			createMailPort(mailConfigFromEnvironment({})),
		);
		await inbox.saveEmailDelivery(TENANT, ADA.accountId, true, clock);
		await publish(publisher, 'run-6', [ADA.accountId]);

		await runner.tick();

		/* The failed attempt and the retry it scheduled; the outcome is on the
		   first. */
		expect(await deliveries.list(TENANT, { status: 'failed' })).toEqual([
			expect.objectContaining({ status: 'failed', errorClass: 'mail-refused' }),
		]);
	});

	/* The address is auth.core's, read at send time, so it is never stored here
	   and a member who lost their membership is simply not reachable. */
	it('fails an attempt addressed to a member the workspace no longer holds', async () => {
		const { publisher, deliveries, inbox, mail, runner } = createHarness({
			repository: shared.repository,
			now: () => clock,
			members: [BO],
		});
		await inbox.saveEmailDelivery(TENANT, ADA.accountId, true, clock);
		await publish(publisher, 'run-7', [ADA.accountId]);

		await runner.tick();

		expect(mail.outbox).toEqual([]);
		/* Nothing to retry: the attempt ends at once instead of spending the
		   budget, exactly as a webhook whose subscription is gone does. */
		expect(await deliveries.list(TENANT, {})).toEqual([
			expect.objectContaining({
				status: 'dead-letter',
				errorClass: 'recipient-unknown',
			}),
		]);
	});
});
