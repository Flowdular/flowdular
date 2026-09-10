import type { DatabaseProvider } from '@flowdular/database';

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
	readonly requiresApprovedSpec: boolean;
	readonly supportsDryRun: boolean;
	readonly localOnly?: boolean;
	readonly confirmation?: string;
}

export interface CliExtensionContext {
	readonly workspaceRoot: string;
	readonly moduleRoot: string;
	readonly apply: boolean;
	readonly flags: ReadonlyMap<string, string | boolean>;
	readonly arguments: readonly string[];
	/**
	 * The configured platform database, for a command that reads the deployment
	 * data. A module owns no driver, so the runner builds this. It is absent
	 * when the workspace declares no usable database configuration. The runner
	 * owns it: release the leases you take and never dispose the provider.
	 */
	readonly databases?: DatabaseProvider;
}

export interface CliExtensionResult {
	readonly data: unknown;
	readonly evidence?: readonly string[];
	readonly warnings?: readonly string[];
}

export interface ModuleCliCommandDescriptor {
	readonly path: readonly [string, ...string[]];
	readonly capability: CapabilityDescriptor;
}

export interface ModuleCliCatalog {
	readonly protocolVersion: 1;
	readonly moduleId: string;
	readonly commands: readonly ModuleCliCommandDescriptor[];
}

export interface ModuleCliCommand extends ModuleCliCommandDescriptor {
	readonly execute: (
		context: CliExtensionContext,
	) => CliExtensionResult | Promise<CliExtensionResult>;
}

export interface ModuleCliExtension {
	readonly protocolVersion: 1;
	readonly moduleId: string;
	readonly commands: readonly ModuleCliCommand[];
}

export function defineCliExtension(
	extension: ModuleCliExtension,
): ModuleCliExtension {
	return Object.freeze(extension);
}

export interface CommandEnvelope<T = unknown> {
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

export function success<T>(
	data: T,
	options: { evidence?: readonly string[]; warnings?: readonly string[] } = {},
): CommandEnvelope<T> {
	return {
		protocolVersion: 1,
		ok: true,
		data,
		warnings: options.warnings ?? [],
		evidence: options.evidence ?? [],
		auditId: crypto.randomUUID(),
	};
}

export function failure(
	code: string,
	message: string,
	details?: unknown,
): CommandEnvelope<never> {
	return {
		protocolVersion: 1,
		ok: false,
		error:
			details === undefined ? { code, message } : { code, message, details },
		warnings: [],
		evidence: [],
		auditId: crypto.randomUUID(),
	};
}
