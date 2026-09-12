import { randomUUID } from 'node:crypto';
import {
	NOTIFICATION_KINDS,
	type NotificationKind,
	type WebhookSubscription,
	type WebhookSubscriptionSecret,
} from '../domain/types.ts';
import { WebhookEgressError, type WebhookEgressPolicy } from './egress.ts';
import type {
	NotificationsRepository,
	StoredWebhookSubscription,
} from './repository.ts';
import {
	generateWebhookSecret,
	secretContext,
	secretFingerprint,
	type SecretVault,
} from './secret-vault.ts';
import { bounded, NotificationsServiceError } from './service-error.ts';

export const SUBSCRIPTION_NAME_MAX = 120;
export const SUBSCRIPTION_URL_MAX = 2_048;
export const SUBSCRIPTION_DESCRIPTION_MAX = 1_000;

export interface WebhookSubscriptionInput {
	readonly name: string;
	readonly url: string;
	readonly events: readonly string[];
	readonly description?: string | null;
}

/** The read shape: the fingerprint is public, the sealed secret never is. */
export function presentSubscription(
	record: StoredWebhookSubscription,
): WebhookSubscription {
	const { secret: _sealed, ...presented } = record;
	return presented;
}

function events(value: readonly string[]): readonly NotificationKind[] {
	const allowed = new Set<string>(NOTIFICATION_KINDS);
	const selected = [...new Set(value.map((entry) => entry.trim()))];
	if (selected.length === 0 || selected.length > NOTIFICATION_KINDS.length) {
		throw new NotificationsServiceError(
			'INVALID_INPUT',
			`events must name between 1 and ${NOTIFICATION_KINDS.length} kinds.`,
		);
	}
	for (const entry of selected) {
		if (!allowed.has(entry)) {
			throw new NotificationsServiceError(
				'INVALID_INPUT',
				`events must be drawn from: ${NOTIFICATION_KINDS.join(', ')}.`,
			);
		}
	}
	/* Stored in the declared order so the same selection always produces the
	   same row and the same containment lookup. */
	return NOTIFICATION_KINDS.filter((kind) => selected.includes(kind));
}

function egressFailure(error: unknown): never {
	if (error instanceof WebhookEgressError) {
		throw new NotificationsServiceError(error.code, error.message, 400);
	}
	throw error;
}

export class WebhookSubscriptionService {
	constructor(
		private readonly repository: NotificationsRepository,
		private readonly vault: SecretVault,
		private readonly policy: () => WebhookEgressPolicy,
		private readonly now: () => number = Date.now,
	) {}

	async list(tenantId: string): Promise<readonly WebhookSubscription[]> {
		return (
			await this.repository.listSubscriptions(
				bounded(tenantId, 'tenantId', 1, 128),
			)
		).map(presentSubscription);
	}

	async get(tenantId: string, id: string): Promise<WebhookSubscription> {
		return presentSubscription(await this.#require(tenantId, id));
	}

	async create(
		tenantId: string,
		actorId: string,
		input: WebhookSubscriptionInput,
	): Promise<WebhookSubscriptionSecret> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const createdBy = bounded(actorId, 'actorId', 1, 128);
		const url = await this.#checkedUrl(input.url);
		const now = this.now();
		const id = randomUUID();
		const secret = generateWebhookSecret();
		const record: StoredWebhookSubscription = {
			id,
			tenantId: trustedTenantId,
			name: bounded(input.name, 'name', 1, SUBSCRIPTION_NAME_MAX),
			url,
			events: events(input.events),
			secretFingerprint: secretFingerprint(secret),
			secretRevision: 1,
			status: 'active',
			description: this.#description(input.description),
			lastDeliveryAt: null,
			createdAt: now,
			updatedAt: now,
			createdBy,
			secret: this.vault.encrypt(secret, secretContext(trustedTenantId, id)),
		};
		const created = await this.repository.createSubscription(record);
		if (!created) throw nameConflict();
		return { subscription: presentSubscription(created), secret };
	}

	async update(
		tenantId: string,
		id: string,
		input: WebhookSubscriptionInput,
	): Promise<WebhookSubscription> {
		const existing = await this.#require(tenantId, id);
		const url = await this.#checkedUrl(input.url);
		const updated = await this.repository.updateSubscription({
			tenantId: existing.tenantId,
			id: existing.id,
			name: bounded(input.name, 'name', 1, SUBSCRIPTION_NAME_MAX),
			url,
			events: events(input.events),
			description: this.#description(input.description),
			updatedAt: this.now(),
		});
		if (updated === 'conflict') throw nameConflict();
		if (!updated) throw notFound();
		return presentSubscription(updated);
	}

	async pause(tenantId: string, id: string): Promise<WebhookSubscription> {
		return this.#transition(tenantId, id, 'paused', ['active']);
	}

	async resume(tenantId: string, id: string): Promise<WebhookSubscription> {
		return this.#transition(tenantId, id, 'active', ['paused', 'disabled']);
	}

	/* Disabling is how a subscription reaches the only state delete accepts. Its
	   pending queue goes with the status change in one write, so nothing that was
	   waiting is ever sent afterwards; the attempts already completed stay in the
	   ledger until retention removes them. */
	async disable(tenantId: string, id: string): Promise<WebhookSubscription> {
		const existing = await this.#require(tenantId, id);
		if (existing.status === 'disabled') return presentSubscription(existing);
		const updated = await this.repository.disableSubscription(
			existing.tenantId,
			existing.id,
			this.now(),
		);
		if (!updated) throw notFound();
		return presentSubscription(updated);
	}

	async rotateSecret(
		tenantId: string,
		id: string,
	): Promise<WebhookSubscriptionSecret> {
		const existing = await this.#require(tenantId, id);
		const secret = generateWebhookSecret();
		const rotated = await this.repository.rotateSubscriptionSecret(
			existing.tenantId,
			existing.id,
			this.vault.encrypt(secret, secretContext(existing.tenantId, existing.id)),
			secretFingerprint(secret),
			this.now(),
		);
		if (!rotated) throw notFound();
		return { subscription: presentSubscription(rotated), secret };
	}

	/* Deleting drops the pending queue with the subscription; the attempt ledger
	   outlives it and is removed by retention. */
	async delete(tenantId: string, id: string): Promise<void> {
		const existing = await this.#require(tenantId, id);
		if (existing.status !== 'disabled') {
			throw new NotificationsServiceError(
				'SUBSCRIPTION_NOT_DISABLED',
				'Only a disabled subscription can be deleted.',
				409,
			);
		}
		if (!(await this.repository.deleteSubscription(tenantId, existing.id))) {
			throw notFound();
		}
	}

	async #transition(
		tenantId: string,
		id: string,
		status: 'active' | 'paused' | 'disabled',
		from: readonly string[],
	): Promise<WebhookSubscription> {
		const existing = await this.#require(tenantId, id);
		if (existing.status === status) return presentSubscription(existing);
		if (!from.includes(existing.status)) {
			throw new NotificationsServiceError(
				'SUBSCRIPTION_STATE_INVALID',
				`A ${existing.status} subscription cannot become ${status}.`,
				409,
			);
		}
		const updated = await this.repository.setSubscriptionStatus(
			existing.tenantId,
			existing.id,
			status,
			this.now(),
		);
		if (!updated) throw notFound();
		return presentSubscription(updated);
	}

	async #require(
		tenantId: string,
		id: string,
	): Promise<StoredWebhookSubscription> {
		const record = await this.repository.getSubscription(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(id, 'subscriptionId', 1, 128),
		);
		if (!record) throw notFound();
		return record;
	}

	/* Both halves of the egress rule run before the row is written: the shape and
	   allowlist, then what the name actually resolves to right now. */
	async #checkedUrl(value: string): Promise<string> {
		const policy = this.policy();
		const raw = bounded(value, 'url', 1, SUBSCRIPTION_URL_MAX);
		try {
			const url = policy.assertUrl(raw);
			await policy.assertResolvable(url.hostname);
			return url.toString();
		} catch (error) {
			egressFailure(error);
		}
	}

	#description(value: string | null | undefined): string | null {
		if (value === undefined || value === null || value.trim() === '') {
			return null;
		}
		return bounded(value, 'description', 1, SUBSCRIPTION_DESCRIPTION_MAX);
	}
}

function notFound(): NotificationsServiceError {
	return new NotificationsServiceError(
		'SUBSCRIPTION_NOT_FOUND',
		'Webhook subscription not found.',
		404,
	);
}

function nameConflict(): NotificationsServiceError {
	return new NotificationsServiceError(
		'SUBSCRIPTION_NAME_CONFLICT',
		'A webhook subscription with this name already exists.',
		409,
	);
}
