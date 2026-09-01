import type { GateResult } from '../gates.ts';
import type { SandboxSession } from '../sessions.ts';
import type { DeliveryConfiguration } from './configuration.ts';
import type { CommandRunner } from './steps.ts';

/* Where a delivery lands. The request names the target; the sandbox resolves
   it to the implementation below. 'workspace' writes into this working tree;
   'git-pr' commits the same change on a branch and opens a pull request. */
export type EjectTarget = 'workspace' | 'git-pr';

export type DeliveryTargetId = 'local' | 'git-pr';

export interface DeliveryModulePlan {
	readonly id: string;
	readonly directory: string;
	readonly kind: 'new' | 'edit';
	/* Relative to the workspace root. */
	readonly targetPath: string;
	readonly files: readonly string[];
	/* Files the target does not have yet. */
	readonly additions: readonly string[];
	readonly overwrites: readonly string[];
	/* Files present in the base copy the session started from and gone from the
	   draft. They are removed from the workspace after the copy. */
	readonly removes: readonly string[];
	/* Packages the module declares that this workspace cannot resolve yet. They
	   are installed by the eject, and a human sees them before that happens. */
	readonly newPackages: readonly string[];
	readonly enable: boolean;
}

export interface DeliveryBudget {
	readonly maxChangedFiles: number;
	readonly maxNewDependencies: number;
}

export interface DeliveryGuardrails {
	readonly ok: boolean;
	readonly reasons: readonly string[];
}

export type DeliveryProvider = 'github' | 'none';

export interface GitDeliveryPlan {
	readonly remote: string;
	readonly baseBranch: string;
	readonly branch: string;
	/* Relative to the workspace root. Created for the delivery and removed when
	   it ends, whatever the outcome. */
	readonly worktreePath: string;
	/* Globs the commit may touch. Anything else left in the worktree fails the
	   guardrail step before a commit exists. */
	readonly allowedPaths: readonly string[];
	readonly budget: DeliveryBudget;
	/* Estimated from the session; the guardrail step counts the real worktree. */
	readonly changedFiles: number;
	readonly newDependencies: readonly string[];
	readonly owners: readonly string[];
	readonly requireReviewer: boolean;
	readonly reviewers: readonly string[];
	readonly guardrails: DeliveryGuardrails;
	readonly provider: DeliveryProvider;
	readonly providerNote: string;
	readonly compareUrl: string | null;
}

export interface DeliveryPlan {
	readonly target: EjectTarget;
	readonly deliveredBy: DeliveryTargetId;
	/* The primary module, repeated at the top level for the current screen. */
	readonly moduleId: string;
	readonly targetPath: string;
	readonly files: readonly string[];
	readonly overwrites: readonly string[];
	readonly removes: readonly string[];
	readonly newPackages: readonly string[];
	readonly enable: boolean;
	/* Every module of the session, primary first. One delivery applies all. */
	readonly modules: readonly DeliveryModulePlan[];
	/* Files created, overwritten, or removed across every module. */
	readonly changedFiles: number;
	readonly gates: readonly string[];
	/* True when the connected application runs on this machine, so the
	   delivery lands in the workspace that application is serving. */
	readonly platformLocal: boolean;
	readonly restartRequired: boolean;
	readonly notes: readonly string[];
	readonly git?: GitDeliveryPlan;
	readonly applied: false;
}

export interface DeliveryStepResult {
	readonly id: string;
	readonly ok: boolean;
	readonly output: string;
	readonly detail?: string;
}

export type DeliveryEmit = (event: string, payload: unknown) => void;

export interface DeliveryContext {
	readonly workspaceRoot: string;
	readonly session: SandboxSession;
	/* Capabilities of the acting principal, never of the stored connection. */
	readonly capabilities: readonly string[];
	readonly platformUrl: string;
	readonly build?: boolean;
	/* The sandbox.delivery block of coreloom.json; defaults when absent. */
	readonly delivery?: DeliveryConfiguration;
	/* Opens the sealed pull-request provider token, if one is configured. */
	readonly gitProviderToken?: () => Promise<string | null>;
	runGates(gates: readonly string[]): Promise<readonly GateResult[]>;
	readonly commands: CommandRunner;
}

export interface DeliveryOutcome {
	readonly moduleId: string;
	readonly targetPath: string;
	readonly files: number;
	readonly removed: number;
	readonly enabled: boolean;
	readonly gates: readonly GateResult[];
	readonly steps: readonly DeliveryStepResult[];
	readonly restartRequired: boolean;
	readonly branch?: string;
	readonly pullRequestUrl?: string | null;
	readonly compareUrl?: string | null;
}

export interface DeliveryAvailability {
	readonly available: boolean;
	readonly reason: string | null;
}

/* A delivery target plans before it writes and streams every step while it
   applies. plan() never touches the workspace; apply() stops at the first
   failing step and throws, so a session is marked delivered only when every
   step passed. */
export interface DeliveryTarget {
	readonly id: DeliveryTargetId;
	available(context: DeliveryContext): Promise<DeliveryAvailability>;
	plan(context: DeliveryContext): Promise<DeliveryPlan>;
	apply(
		context: DeliveryContext,
		plan: DeliveryPlan,
		emit: DeliveryEmit,
	): Promise<DeliveryOutcome>;
}
