export {
	ApprovalsService,
	APPROVALS_PAGE_LIMIT,
	EXPIRY_BATCH,
} from './approvals-service.ts';
export type { ApprovalsServiceOptions } from './approvals-service.ts';
export { createApprovalCallbackRegistry } from './callbacks.ts';
export type {
	ApprovalCallbackRegistry,
	ApprovalResolvedCallback,
} from './callbacks.ts';
export {
	memberSatisfies,
	normalizeRequirement,
	resolveEligible,
} from './eligibility.ts';
export { publishApprovalEvent } from './notifications.ts';
export type {
	NotificationPublisher,
	NotificationPublisherResolver,
} from './notifications.ts';
export type {
	ApprovalRequestFilters,
	ApprovalsRepository,
	CreateApprovalResult,
	DecideApprovalInput,
	DecideApprovalResult,
} from './repository.ts';
export {
	DatabaseApprovalsRepository,
	migrateApprovalsDatabase,
} from './database-repository.ts';
export { ApprovalsServiceError } from './service-error.ts';
