import {
	defineCliExtension,
	type CliExtensionContext,
	type CliExtensionResult,
} from '@flowdular/cli-protocol';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
} from '@flowdular/module-auth/server';
import { METER_LIMITS } from '../domain/meters.ts';
import { createMeteringRuntime } from '../server/runtime.ts';
import { MeteringServiceError } from '../services/service-error.ts';
import { DEFAULT_WARNING_PERCENT } from '../settings.ts';

const listCapability = {
	id: 'metering.limits.list',
	version: 1,
	summary: 'List the monthly meter limits of one workspace.',
	risk: 'read' as const,
	requiresApprovedSpec: false,
	supportsDryRun: false,
};

const setCapability = {
	id: 'metering.limits.set',
	version: 1,
	summary: 'Set the monthly limit of one meter for one workspace.',
	risk: 'process' as const,
	requiresApprovedSpec: false,
	supportsDryRun: true,
};

const EVIDENCE = ['modules/metering/spec/module.yaml', 'docs/cli.md'] as const;

const USAGE =
	'Use metering limits set --workspace <slug|id> --meter <key> --monthly-limit <n> [--apply].';

interface Workspace {
	readonly tenantId: string;
	readonly slug: string;
	readonly name: string;
}

function stringFlag(context: CliExtensionContext, name: string): string {
	const value = context.flags.get(name);
	if (typeof value !== 'string' || value.trim() === '') {
		throw new MeteringServiceError(
			'INPUT_REQUIRED',
			`${USAGE} --${name} is missing.`,
		);
	}
	return value.trim();
}

function integerFlag(context: CliExtensionContext, name: string): number {
	const raw = stringFlag(context, name);
	const value = Number(raw);
	if (
		!/^\d+$/.test(raw) ||
		!Number.isSafeInteger(value) ||
		value > METER_LIMITS.monthlyLimit
	) {
		throw new MeteringServiceError(
			'INVALID_INPUT',
			`--${name} must be a whole number between 0 and ${METER_LIMITS.monthlyLimit}.`,
		);
	}
	return value;
}

function databases(context: CliExtensionContext) {
	if (!context.databases) {
		throw new MeteringServiceError(
			'DATABASE_UNAVAILABLE',
			'metering.core CLI commands read the deployment database, and this workspace has none configured.',
			503,
		);
	}
	return context.databases;
}

/**
 * Resolves a workspace slug or identifier through auth.core's own service, on
 * auth.core's own leases. metering.core never opens another module's table.
 */
async function resolveWorkspace(
	context: CliExtensionContext,
	reference: string,
): Promise<Workspace> {
	const auth = createAuthRuntime({
		databases: databases(context),
		...authRuntimeOptionsFromEnvironment(process.env, context.workspaceRoot),
	});
	try {
		const tenant = await (await auth.service()).findTenant(reference);
		if (!tenant) {
			throw new MeteringServiceError(
				'WORKSPACE_NOT_FOUND',
				`No workspace matches "${reference}".`,
				404,
			);
		}
		return { tenantId: tenant.tenantId, slug: tenant.slug, name: tenant.name };
	} finally {
		await auth.dispose();
	}
}

/* The operator runs these outside a composed platform, so no module has
   declared a meter and no threshold can be published from here: the runtime is
   opened for its leases and its repository only.

   A command that is not applying anything applies no schema either: a read and
   a dry run verify the ledger and stop there, so `metering limits list` can
   never be what creates this module's tables in a deployment. */
async function withRuntime<T>(
	context: CliExtensionContext,
	operation: (runtime: ReturnType<typeof createMeteringRuntime>) => Promise<T>,
): Promise<T> {
	const runtime = createMeteringRuntime({
		databases: databases(context),
		warningPercent: () => DEFAULT_WARNING_PERCENT,
		migrations: context.apply ? 'apply' : 'verify',
	});
	try {
		return await operation(runtime);
	} finally {
		await runtime.dispose();
	}
}

/** The person who ran the command, as the limit row records them. */
function operatorLabel(): string {
	return `cli:${process.env.USER ?? 'operator'}`;
}

export const cliExtension = defineCliExtension({
	protocolVersion: 1,
	moduleId: 'metering.core',
	commands: [
		{
			path: ['metering', 'limits', 'list'],
			capability: listCapability,
			execute: async (context): Promise<CliExtensionResult> => {
				const workspace = await resolveWorkspace(
					context,
					stringFlag(context, 'workspace'),
				);
				return withRuntime(context, async (runtime) => {
					const service = await runtime.service();
					const limits = await service.limits(workspace.tenantId);
					const usage = await service.usage(workspace.tenantId);
					const used = new Map(
						usage.map((entry) => [entry.meter.key, entry.used]),
					);
					return {
						data: {
							moduleId: 'metering.core',
							workspace: workspace.slug,
							limits: limits.map((limit) => ({
								meter: limit.meter,
								monthlyLimit: limit.monthlyLimit,
								usedThisMonth: used.get(limit.meter) ?? 0,
								setBy: limit.setBy,
								updatedAt: new Date(limit.updatedAt).toISOString(),
							})),
						},
						evidence: [...EVIDENCE],
					};
				});
			},
		},
		{
			path: ['metering', 'limits', 'set'],
			capability: setCapability,
			execute: async (context): Promise<CliExtensionResult> => {
				const reference = stringFlag(context, 'workspace');
				const meter = stringFlag(context, 'meter');
				if (meter.length > METER_LIMITS.key) {
					throw new MeteringServiceError(
						'INVALID_INPUT',
						`--meter must be at most ${METER_LIMITS.key} characters.`,
					);
				}
				const monthlyLimit = integerFlag(context, 'monthly-limit');
				const workspace = await resolveWorkspace(context, reference);
				return withRuntime(context, async (runtime) => {
					const service = await runtime.service();
					const before =
						(await service.limits(workspace.tenantId)).find(
							(limit) => limit.meter === meter,
						) ?? null;
					/* An operator caps a meter before the workspace has reported its
					   first fact, so an unrecorded meter is a warning, never a
					   refusal. */
					const recorded = (await service.usage(workspace.tenantId)).some(
						(entry) => entry.meter.key === meter,
					);
					const warnings = recorded
						? []
						: [
								`This workspace has not recorded the meter "${meter}" yet. The limit applies from its first fact.`,
							];
					if (!context.apply) {
						return {
							data: {
								moduleId: 'metering.core',
								applied: false,
								workspace: workspace.slug,
								meter,
								previousLimit: before?.monthlyLimit ?? null,
								monthlyLimit,
								setBy: operatorLabel(),
							},
							evidence: [...EVIDENCE],
							warnings,
						};
					}
					const saved = await service.setLimit({
						tenantId: workspace.tenantId,
						meter,
						monthlyLimit,
						setBy: operatorLabel(),
					});
					return {
						data: {
							moduleId: 'metering.core',
							applied: true,
							workspace: workspace.slug,
							meter: saved.limit.meter,
							previousLimit: saved.previousLimit,
							monthlyLimit: saved.limit.monthlyLimit,
							setBy: saved.limit.setBy,
							auditEventId: saved.event.id,
							occurredAt: new Date(saved.event.occurredAt).toISOString(),
						},
						evidence: [...EVIDENCE],
						warnings,
					};
				});
			},
		},
	],
});

export default cliExtension;
