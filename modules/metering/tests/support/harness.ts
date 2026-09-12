import type { MeterDeclaration } from '../../src/domain/meters.ts';
import { MeterDeclarationRegistry } from '../../src/services/meter-registry.ts';
import { MeteringService } from '../../src/services/metering-service.ts';
import type {
	NotificationPublishInput,
	NotificationPublisher,
} from '../../src/services/notifications.ts';
import type { MeteringRepository } from '../../src/services/repository.ts';

/** The meter every case reports against, declared by a stand-in module. */
export const REPORTER = 'agents.core';
export const RUN_TOKENS: MeterDeclaration = {
	key: 'run-tokens',
	label: 'Agent run tokens',
	unit: 'tokens',
	kind: 'cumulative',
};
export const RUN_TOKENS_KEY = `${REPORTER}.${RUN_TOKENS.key}`;

/** A clock a case moves by hand, so a month boundary is not a wall-clock wait. */
export function clock(start: number) {
	let now = start;
	return {
		now: () => now,
		set(value: number) {
			now = value;
		},
	};
}

/** Records what reached notifications.core without opening that module. */
export function recordingPublisher(): NotificationPublisher & {
	readonly published: NotificationPublishInput[];
} {
	const published: NotificationPublishInput[] = [];
	return {
		published,
		publish: async (input) => {
			published.push(input);
			return { inboxItemIds: ['inbox-1'], deliveryIds: [] };
		},
	};
}

export interface HarnessOptions {
	readonly repository: MeteringRepository;
	readonly now?: () => number;
	readonly warningPercent?: () => number;
	readonly owners?: readonly string[];
	readonly publisher?: NotificationPublisher | null;
	readonly meters?: readonly MeterDeclaration[];
}

export function createHarness(options: HarnessOptions) {
	const registry = new MeterDeclarationRegistry();
	registry.declare(REPORTER, options.meters ?? [RUN_TOKENS]);
	const service = new MeteringService({
		repository: options.repository,
		registry,
		warningPercent: options.warningPercent ?? (() => 80),
		owners: async () => options.owners ?? ['account-owner'],
		notifications: () => options.publisher ?? null,
		...(options.now ? { now: options.now } : {}),
	});
	return { registry, service };
}
