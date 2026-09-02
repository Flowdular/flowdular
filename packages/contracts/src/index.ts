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

export interface ModuleManifest {
	readonly $schema?: string;
	readonly schemaVersion: 1;
	readonly id: string;
	readonly package: string;
	readonly version: string;
	readonly profile: ModuleProfile;
	readonly capabilities: readonly ModuleCapability[];
	readonly dependencies: readonly ModuleDependency[];
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

export interface ModuleSpec {
	readonly schemaVersion: 1;
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
}

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
