import { SandboxSetupError } from '../workspace-root.ts';
import { createGitPullRequestDeliveryTarget } from './git-pr.ts';
import { createLocalDeliveryTarget } from './local.ts';
import type { DeliveryTarget, EjectTarget } from './types.ts';

const TARGETS: Readonly<Record<EjectTarget, () => DeliveryTarget>> = {
	workspace: createLocalDeliveryTarget,
	'git-pr': createGitPullRequestDeliveryTarget,
};

export function isEjectTarget(value: string): value is EjectTarget {
	return Object.hasOwn(TARGETS, value);
}

export function assertEjectTarget(value: string): EjectTarget {
	if (!isEjectTarget(value)) {
		throw new SandboxSetupError(
			'EJECT_TARGET_UNSUPPORTED',
			`The ${value} eject target is not implemented in this sandbox yet. Use workspace or git-pr.`,
		);
	}
	return value;
}

/* The request names where the delivery should land; this is the only place
   that knows which implementation answers for it. */
export function resolveDeliveryTarget(target: string): DeliveryTarget {
	return TARGETS[assertEjectTarget(target)]();
}

export {
	DEFAULT_DELIVERY_CONFIGURATION,
	readDeliveryConfiguration,
	resolveDeliveryConfiguration,
} from './configuration.ts';
export type {
	DeliveryConfiguration,
	GitDeliveryConfiguration,
} from './configuration.ts';
export { createGitPullRequestDeliveryTarget } from './git-pr.ts';
export {
	loadPathOwnership,
	loadTaskBudgets,
	matchesPath,
	ownerOf,
	parsePolicyYaml,
} from './policies.ts';
export type { PathOwnership, TaskBudgets } from './policies.ts';
export { createLocalDeliveryTarget } from './local.ts';
export { readDeliveryRecord, writeDeliveryRecord } from './record.ts';
export type { DeliveryRecord } from './record.ts';
export {
	DeliveryError,
	assertGatesPassed,
	listModuleFiles,
	newPackages,
	planModuleFiles,
	spawnCommand,
} from './steps.ts';
export type {
	CommandOptions,
	CommandResult,
	CommandRunner,
	StepResult,
} from './steps.ts';
export type {
	DeliveryAvailability,
	DeliveryBudget,
	DeliveryContext,
	DeliveryEmit,
	DeliveryGuardrails,
	DeliveryModulePlan,
	DeliveryOutcome,
	DeliveryPlan,
	DeliveryProvider,
	DeliveryStepResult,
	DeliveryTarget,
	DeliveryTargetId,
	EjectTarget,
	GitDeliveryPlan,
} from './types.ts';
