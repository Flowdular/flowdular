import { APPROVAL_LIMITS } from '../domain/capability.ts';
import type { ApprovalRequest } from '../domain/types.ts';

export type ApprovalResolvedCallback = (
	request: ApprovalRequest,
) => Promise<void>;

export interface ApprovalCallbackRegistry {
	register(
		tenantId: string,
		requestId: string,
		callback: ApprovalResolvedCallback,
	): void;
	/** Runs the callback for a resolved request, at most once, and forgets it. */
	run(request: ApprovalRequest): Promise<void>;
	forget(tenantId: string, requestId: string): void;
	readonly size: number;
}

function key(tenantId: string, requestId: string): string {
	return `${tenantId}::${requestId}`;
}

/**
 * In-process callbacks a subject module registered when it opened a request.
 * A restart loses them, which is why the capability documents reading the
 * request back as the durable path; this is the fast path, not the contract.
 */
export function createApprovalCallbackRegistry(
	limit = APPROVAL_LIMITS.callbacks,
): ApprovalCallbackRegistry {
	const callbacks = new Map<string, ApprovalResolvedCallback>();
	return {
		register(tenantId, requestId, callback) {
			const entry = key(tenantId, requestId);
			/* Re-registering moves the entry to the end of the eviction order, so a
			   subject module that reopened its request keeps the newest callback. */
			callbacks.delete(entry);
			if (callbacks.size >= limit) {
				const oldest = callbacks.keys().next();
				if (!oldest.done) {
					callbacks.delete(oldest.value);
					console.warn(
						`[approvals] dropped the resolution callback for ${oldest.value}: ${limit} callbacks are already pending.`,
					);
				}
			}
			callbacks.set(entry, callback);
		},
		async run(request) {
			const entry = key(request.tenantId, request.id);
			const callback = callbacks.get(entry);
			/* Deleting before the call is what makes this once per terminal state:
			   a second resolution racing this one finds nothing to run. */
			callbacks.delete(entry);
			if (!callback) return;
			/* Foreign code on the resolution path. A callback that throws is the
			   subject module's problem, never the recorded decision's. */
			try {
				await callback(request);
			} catch (error) {
				console.warn(
					`[approvals] resolution callback for request ${request.id} failed:`,
					error instanceof Error ? error.message : error,
				);
			}
		},
		forget(tenantId, requestId) {
			callbacks.delete(key(tenantId, requestId));
		},
		get size() {
			return callbacks.size;
		},
	};
}
