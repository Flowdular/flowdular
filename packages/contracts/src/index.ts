/* Version of the public platform contract, independent of application
   versions. While it stays below 1.0.0 a patch bump means an additive change
   that `^0.1.0` consumers still accept, and a minor bump means a member was
   removed or changed. The surface is pinned by
   packages/kernel/platform-api.snapshot.d.ts; `pnpm platform-api:check` fails
   when the surface changes without a bump here. */
export const PLATFORM_API_VERSION = '0.1.4';

/* The workspace time zone: one tenant setting, declared by the module named
   here and read by any module that shows or schedules a local time. The id, the
   key and the fallback live here so a reader never restates them. */
export const TENANT_TIME_ZONE_SETTING = {
	moduleId: 'system.core',
	key: 'timeZone',
	defaultValue: 'UTC',
} as const;

export type ModuleCapability =
	| 'api'
	| 'database'
	| 'client'
	| 'translations'
	| 'integration'
	| 'cli';

export type ModuleProfile = 'full' | 'headless' | 'ui' | 'integration';

export type ModuleStability = 'experimental' | 'stable' | 'deprecated';

export interface ModuleDependency {
	readonly id: string;
	readonly range: string;
}

/* A public capability id another module registers through
   `context.capabilities`, such as `notifications.publish.v1`. The version is
   part of the id, so compatibility is asserted by name, not by module version. */
export interface ModuleCapabilityRequirement {
	readonly id: string;
	/* An optional requirement is resolved with `get` returning null when no
	   enabled module provides it; a required one fails composition. */
	readonly optional?: boolean;
}

export interface ModuleManifest {
	readonly platformApi?: string;
	readonly $schema?: string;
	readonly schemaVersion: 1;
	readonly id: string;
	readonly package: string;
	readonly version: string;
	readonly profile: ModuleProfile;
	readonly capabilities: readonly ModuleCapability[];
	readonly dependencies: readonly ModuleDependency[];
	/** Capability ids this module registers at composition. */
	readonly provides?: readonly string[];
	/** Capability ids this module resolves from other modules. */
	readonly requires?: readonly ModuleCapabilityRequirement[];
	readonly tenancy: 'required' | 'optional' | 'none';
	readonly locales: readonly string[];
	readonly stability: ModuleStability;
	readonly cli?: {
		readonly catalog: string;
		readonly entry: string;
	};
}

export interface BlueprintManifest {
	readonly $schema?: string;
	readonly schemaVersion: 1;
	readonly id: string;
	readonly version: string;
	readonly architecture: string;
	readonly risk:
		| 'read'
		| 'workspace-write'
		| 'process'
		| 'external'
		| 'destructive';
	readonly owner: string;
	readonly agentRoles: readonly string[];
	readonly executorProfiles: readonly string[];
	readonly requiredReviewers: readonly string[];
	readonly requiresApprovedSpec: boolean;
	readonly status: 'draft' | 'approved' | 'deprecated';
}

export type ModuleSpecFieldType =
	| 'string'
	| 'text'
	| 'integer'
	| 'decimal'
	| 'boolean'
	| 'date'
	| 'datetime'
	| 'enum'
	| 'reference'
	| 'json';

export interface ModuleSpecField {
	readonly id: string;
	readonly type: ModuleSpecFieldType;
	readonly required?: boolean;
	readonly unique?: 'tenant' | 'none';
	readonly maxLength?: number;
	/* Enum members; required when type is enum. */
	readonly values?: readonly string[];
	/* "<entityId>" in this spec, or "<moduleId>.<entityId>" in a dependency. */
	readonly reference?: string;
	readonly description?: string;
}

export interface ModuleSpecStates {
	readonly field: string;
	readonly values: readonly string[];
	readonly transitions?: readonly {
		readonly from: string;
		readonly to: string;
		readonly permission?: string;
	}[];
}

export interface ModuleSpecEntity {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly fields: readonly ModuleSpecField[];
	readonly states?: ModuleSpecStates;
}

export interface ModuleSpecScreen {
	readonly id: string;
	readonly kind: 'list' | 'record' | 'form' | 'dashboard';
	readonly entity?: string;
	readonly title?: string;
	readonly columns?: readonly string[];
	readonly filters?: readonly string[];
	readonly navigationGroup?: string;
}

export interface ModuleSpecAction {
	readonly id: string;
	readonly entity?: string;
	readonly permission: string;
	readonly kind: 'create' | 'update' | 'delete' | 'custom';
	readonly risk: 'read' | 'workspace-write' | 'external' | 'destructive';
	readonly idempotent: boolean;
	readonly description: string;
}

export interface ModuleSpecWidget {
	readonly id: string;
	readonly slot:
		| 'dashboard.metrics'
		| 'dashboard.main'
		| 'dashboard.aside'
		| 'topbar.actions';
	readonly entity?: string;
	readonly description: string;
}

export interface ModuleSpecSetting {
	readonly key: string;
	readonly type: 'string' | 'integer' | 'boolean' | 'enum';
	readonly scope: 'tenant' | 'platform';
	readonly default?: string | number | boolean;
	readonly values?: readonly string[];
	readonly description: string;
}

export interface ModuleSpecAgentTool {
	readonly id: string;
	readonly permission: string;
	readonly description: string;
	readonly risk: 'read' | 'workspace-write';
}

export interface ModuleSpecDecision {
	readonly id: string;
	readonly question: string;
	readonly answer: string;
	readonly decidedBy: 'user' | 'default';
}

export interface ModuleSpec {
	readonly schemaVersion: 1 | 2;
	readonly id: string;
	readonly specVersion: string;
	readonly status:
		| 'draft'
		| 'in-review'
		| 'approved'
		| 'implemented'
		| 'deprecated';
	readonly name: string;
	readonly description: string;
	readonly profile: ModuleProfile;
	readonly capabilities: readonly ModuleCapability[];
	readonly dependencies: readonly ModuleDependency[];
	readonly provides?: readonly string[];
	readonly requires?: readonly ModuleCapabilityRequirement[];
	readonly tenancy: 'required' | 'optional' | 'none';
	readonly locales: readonly string[];
	readonly invariants?: readonly string[];
	readonly permissions?: readonly {
		readonly id: string;
		readonly description: string;
	}[];
	readonly dataOwnership?: readonly string[];
	readonly acceptanceScenarios?: readonly {
		readonly id: string;
		readonly given: string;
		readonly when: string;
		readonly then: string;
	}[];
	/* Domain model, accepted only with schemaVersion 2. Every member stays
	   optional so a specification can adopt version 2 section by section. */
	readonly entities?: readonly ModuleSpecEntity[];
	readonly screens?: readonly ModuleSpecScreen[];
	readonly actions?: readonly ModuleSpecAction[];
	readonly widgets?: readonly ModuleSpecWidget[];
	readonly settings?: readonly ModuleSpecSetting[];
	readonly agentTools?: readonly ModuleSpecAgentTool[];
	readonly outOfScope?: readonly string[];
	readonly decisions?: readonly ModuleSpecDecision[];
}

/** A specification that carries the version 2 domain model. */
export type ModuleSpecV2 = ModuleSpec & { readonly schemaVersion: 2 };

export interface ValidationIssue {
	readonly code: string;
	readonly message: string;
	readonly path?: string;
	readonly severity: 'error' | 'warning';
}

export interface ValidationReport {
	readonly valid: boolean;
	readonly issues: readonly ValidationIssue[];
}

export interface NavigationContribution {
	readonly id: string;
	readonly label: string;
	readonly href: string;
	readonly order?: number;
	readonly permission?: string;
}

export interface RegisteredModule {
	readonly manifest: ModuleManifest;
	readonly navigation?: readonly NavigationContribution[];
	readonly permissions?: readonly string[];
}

export type CapabilityRisk =
	| 'read'
	| 'workspace-write'
	| 'process'
	| 'external'
	| 'destructive';

export interface CapabilityDescriptor {
	readonly id: string;
	readonly version: number;
	readonly summary: string;
	readonly risk: CapabilityRisk;
}

export interface CliEnvelope<T> {
	readonly protocolVersion: 1;
	readonly ok: boolean;
	readonly data?: T;
	readonly error?: {
		readonly code: string;
		readonly message: string;
		readonly details?: unknown;
	};
	readonly warnings: readonly string[];
	readonly evidence: readonly string[];
	readonly auditId: string;
}

export {
	blueprintSchema,
	cliExtensionSchema,
	moduleSchema,
	moduleSpecSchema,
	platformSpecSchema,
	projectSchema,
} from './schemas.ts';

export {
	extractVariables,
	isVariableKey,
	resolveTemplate,
	tokenizeTemplate,
	validateTemplate,
	variableDefinitions,
	variablesForScopes,
	VARIABLE_KEY_PATTERN,
} from './variables.ts';
export type {
	ResolveTemplateOptions,
	TemplateSegment,
	TemplateValidation,
	VariableDefinition,
	VariableKind,
	VariableSource,
} from './variables.ts';

export type {
	ModuleReviewEvidence,
	ModuleSourceFile,
	ModuleArtifact,
	ModuleRelease,
	ModuleCatalog,
	InstalledModule,
	ModuleInstallLock,
} from './module-distribution.ts';

export { moduleCatalogSchema, moduleArtifactSchema } from './schemas.ts';

export type {
	WebMount,
	WebIdentity,
	WebAccess,
	WebJson,
	WebPage,
	WebPageContext,
	ModuleWebSurface,
	WebModuleComposition,
} from './web.ts';
