export { createApprovalsRoutes, endpoints } from '../api/endpoints.ts';
export {
	DatabaseApprovalsRepository,
	migrateApprovalsDatabase,
} from '../services/database-repository.ts';
export type { ApprovalsDatabaseHandles } from '../services/database-repository.ts';
export { createApprovalsRuntime } from './runtime.ts';
export type { ApprovalsRuntime, ApprovalsRuntimeOptions } from './runtime.ts';
export {
	ApprovalsService,
	APPROVALS_PAGE_LIMIT,
	EXPIRY_BATCH,
} from '../services/approvals-service.ts';
export type { ApprovalsServiceOptions } from '../services/approvals-service.ts';
export { createApprovalCallbackRegistry } from '../services/callbacks.ts';
export type {
	ApprovalCallbackRegistry,
	ApprovalResolvedCallback,
} from '../services/callbacks.ts';
export {
	memberSatisfies,
	normalizeRequirement,
	resolveEligible,
} from '../services/eligibility.ts';
export type {
	ApprovalRequestFilters,
	ApprovalsRepository,
	CreateApprovalResult,
	DecideApprovalInput,
	DecideApprovalResult,
} from '../services/repository.ts';
export { ApprovalsServiceError } from '../services/service-error.ts';
export {
	APPROVALS_MODULE_ID,
	APPROVALS_MODULE_SETTINGS,
	approvalsDefaultExpiryDays,
	approvalsExpiryIntervalMs,
} from '../settings.ts';
