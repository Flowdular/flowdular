import type { UserActor } from '@flowdular/kernel';

export const AUTOMATION_TARGETS_CAPABILITY = 'automations.targets.v1';

export type AutomationTargetJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly AutomationTargetJsonValue[]
	| { readonly [key: string]: AutomationTargetJsonValue };

export interface AutomationTargetReference {
	readonly key: string;
	readonly label: string;
	readonly revision?: number;
}

export interface AutomationTargetAuthorizationContext {
	readonly tenantId: string;
	readonly actor: UserActor;
	readonly permissionSnapshot: readonly string[];
}

export type AutomationTargetInvocationSource =
	| {
			readonly kind: 'schedule';
			readonly scheduleId: string;
			readonly slot: number;
	  }
	| {
			readonly kind: 'run-now';
			readonly scheduleId: string;
			readonly requestId: string;
			readonly actor: UserActor;
	  }
	| {
			readonly kind: 'webhook';
			readonly triggerId: string;
			readonly acceptedSignatureDigest: string;
	  };

export interface AutomationTargetInvocationContext {
	readonly tenantId: string;
	readonly configuredBy: UserActor;
	readonly permissionSnapshot: readonly string[];
	readonly source: AutomationTargetInvocationSource;
}

export interface AutomationTargetInvocationRequest {
	readonly targetKey: string;
	readonly input: AutomationTargetJsonValue;
}

export interface AutomationTargetInvocationResult {
	readonly correlationId: string;
	readonly created: boolean;
	readonly status: string;
}

export interface AutomationTargetAdapter {
	readonly kind: string;
	readonly contractVersion: 1;
	available(): boolean;
	list(
		context: AutomationTargetAuthorizationContext,
	): Promise<readonly AutomationTargetReference[]>;
	validate(
		targetKey: string,
		context: AutomationTargetAuthorizationContext,
	): Promise<AutomationTargetReference>;
	invoke(
		request: AutomationTargetInvocationRequest,
		context: AutomationTargetInvocationContext,
	): Promise<AutomationTargetInvocationResult>;
}

export interface AutomationTargetRegistry {
	register(adapter: AutomationTargetAdapter): void;
	get(kind: string): AutomationTargetAdapter | null;
	list(): readonly AutomationTargetAdapter[];
}

function validKind(kind: string): boolean {
	return /^[a-z][a-z0-9-]{1,63}$/.test(kind);
}

export function createAutomationTargetRegistry(): AutomationTargetRegistry {
	const adapters = new Map<string, AutomationTargetAdapter>();
	return {
		register(adapter) {
			if (!validKind(adapter.kind)) {
				throw new Error(`Automation target kind ${adapter.kind} is invalid.`);
			}
			if (adapter.contractVersion !== 1) {
				throw new Error(
					`Automation target ${adapter.kind} uses an unsupported contract version.`,
				);
			}
			if (adapters.has(adapter.kind)) {
				throw new Error(
					`Automation target ${adapter.kind} is already registered.`,
				);
			}
			adapters.set(adapter.kind, adapter);
		},
		get(kind) {
			return adapters.get(kind) ?? null;
		},
		list() {
			return [...adapters.values()].sort((left, right) =>
				left.kind.localeCompare(right.kind),
			);
		},
	};
}
