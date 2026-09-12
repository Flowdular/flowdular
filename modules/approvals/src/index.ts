import type { ModuleManifest, RegisteredModule } from '@flowdular/contracts';
import manifest from '../module.json' with { type: 'json' };
import { APPROVALS_PERMISSIONS } from './acl/permissions.ts';

export const moduleDefinition = {
	manifest: manifest as ModuleManifest,
	navigation: [
		{
			id: 'approvals.navigation',
			label: 'Approvals',
			href: '/approvals',
			order: 50,
			permission: APPROVALS_PERMISSIONS.read,
		},
	],
	permissions: Object.values(APPROVALS_PERMISSIONS),
} satisfies RegisteredModule;

export { APPROVALS_PERMISSIONS } from './acl/permissions.ts';

/* The cross-module contract. A subject module imports the identifier and the
   types from here and resolves the implementation through the capability
   registry; nothing else in this module is meant to be imported by another one. */
export {
	APPROVALS_REQUESTS_CAPABILITY,
	APPROVAL_LIMITS,
} from './domain/capability.ts';
export type {
	ApprovalRequestFilter,
	ApprovalsRequests,
	OpenApprovalInput,
} from './domain/capability.ts';

export {
	APPROVAL_DECISIONS,
	APPROVAL_STATUSES,
	TERMINAL_APPROVAL_STATUSES,
	isTerminalApprovalStatus,
} from './domain/types.ts';
export type {
	ApprovalDecision,
	ApprovalDecisionKind,
	ApprovalMember,
	ApprovalRequest,
	ApprovalRequestDetail,
	ApprovalRequirementRecord,
	ApprovalRouting,
	ApprovalStatus,
	TerminalApprovalStatus,
} from './domain/types.ts';

export { ApprovalsServiceError } from './services/service-error.ts';
