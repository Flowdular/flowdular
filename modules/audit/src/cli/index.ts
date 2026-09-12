import { isAbsolute, resolve } from 'node:path';
import {
	defineCliExtension,
	type CapabilityDescriptor,
	type CliExtensionContext,
} from '@flowdular/cli-protocol';
import { createDataClassRegistry } from '@flowdular/kernel';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
} from '@flowdular/module-auth/server';
import catalog from './commands.json' with { type: 'json' };
import { HOLD_SCOPE_KINDS, type HoldScopeKind } from '../domain/types.ts';
import { createAuditRuntime, type AuditRuntime } from '../server/runtime.ts';
import { anchorSignerFromEnvironment } from '../services/anchor-key.ts';
import { rotateAnchorSignatures } from '../services/anchor-rotation.ts';
import {
	awaitErasureRun,
	erasureSubjectMarker,
} from '../services/erasure-service.ts';
import {
	awaitExportRun,
	EXPORT_EXCLUSIONS,
} from '../services/export-service.ts';
import {
	HOLD_LIMITS,
	holdStatusOrUndefined,
} from '../services/hold-service.ts';
import { AuditServiceError, oneOf } from '../services/service-error.ts';

/* The catalogue is the declaration the runner validates against, so the
   descriptors the implementation carries are read from it rather than typed
   twice: two copies of the same summary is a command the runner refuses. */
const CAPABILITIES = new Map<string, CapabilityDescriptor>(
	catalog.commands.map((command) => [
		command.path.join(' '),
		command.capability as CapabilityDescriptor,
	]),
);

function capability(path: string): CapabilityDescriptor {
	const found = CAPABILITIES.get(path);
	if (!found) throw new Error(`audit.core declares no CLI command "${path}".`);
	return found;
}

function stringFlag(
	context: CliExtensionContext,
	name: string,
	usage: string,
): string {
	const value = context.flags.get(name);
	if (typeof value !== 'string' || value.trim() === '') {
		throw new AuditServiceError(
			'INPUT_REQUIRED',
			`${usage}; --${name} is missing.`,
		);
	}
	return value.trim();
}

function optionalFlag(
	context: CliExtensionContext,
	name: string,
): string | undefined {
	const value = context.flags.get(name);
	return typeof value === 'string' && value.trim() !== ''
		? value.trim()
		: undefined;
}

function timestampFlag(
	context: CliExtensionContext,
	name: string,
): number | null {
	const value = optionalFlag(context, name);
	if (value === undefined) return null;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) {
		throw new AuditServiceError(
			'INVALID_INPUT',
			`--${name} must be an ISO 8601 date or date and time.`,
		);
	}
	return parsed;
}

function directoryFlag(
	context: CliExtensionContext,
	name: string,
	usage: string,
): string {
	const value = stringFlag(context, name, usage);
	return isAbsolute(value) ? value : resolve(context.workspaceRoot, value);
}

/**
 * Resolves a workspace slug or identifier through auth.core's own service, on
 * auth.core's own leases. audit.core never opens another module's table.
 */
async function resolveWorkspace(
	context: CliExtensionContext,
	reference: string,
): Promise<{ tenantId: string; slug: string; name: string }> {
	const databases = context.databases;
	if (!databases) {
		throw new AuditServiceError(
			'DATABASE_UNAVAILABLE',
			'audit.core CLI commands read the deployment database, and this workspace has none configured.',
		);
	}
	const auth = createAuthRuntime({
		databases,
		...authRuntimeOptionsFromEnvironment(process.env, context.workspaceRoot),
	});
	try {
		const tenant = await (await auth.service()).findTenant(reference);
		if (!tenant) {
			throw new AuditServiceError(
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

/**
 * A runtime for one operator command. It composes no declaring module, so its
 * data class registry is empty and it reaches no owner port: it records the
 * request, or works on rows audit.core owns itself. Neither background loop
 * belongs to this process, so it never starts them.
 */
function operatorRuntime(context: CliExtensionContext): AuditRuntime {
	if (!context.databases) {
		throw new AuditServiceError(
			'DATABASE_UNAVAILABLE',
			'audit.core CLI commands read the deployment database, and this workspace has none configured.',
		);
	}
	return createAuditRuntime({
		databases: context.databases,
		dataClasses: createDataClassRegistry(),
		environment: process.env,
		workspaceRoot: context.workspaceRoot,
		sweepIntervalMs: () => 60 * 60_000,
		sweepBatchSize: () => 500,
	});
}

function operatorLabel(): string {
	return `cli:${process.env.USER ?? 'operator'}`;
}

const SPEC_EVIDENCE = 'modules/audit/spec/module.yaml';

export const cliExtension = defineCliExtension({
	protocolVersion: 1,
	moduleId: 'audit.core',
	commands: [
		{
			path: ['audit', 'export'],
			capability: capability('audit export'),
			execute: async (context) => {
				const reference = stringFlag(
					context,
					'workspace',
					'Use audit export --workspace <slug|id> --output <dir> [--apply]',
				);
				const output = directoryFlag(
					context,
					'output',
					'Use audit export --workspace <slug|id> --output <dir> [--apply]',
				);
				const workspace = await resolveWorkspace(context, reference);
				const runtime = operatorRuntime(context);
				try {
					const exports = await runtime.exports();
					const repository = await runtime.repository();
					const requested = await exports.request({
						tenantId: workspace.tenantId,
						slug: workspace.slug,
						name: workspace.name,
						requestedBy: operatorLabel(),
						outputDirectory: output,
						apply: context.apply,
					});
					const run = await awaitExportRun(
						repository,
						workspace.tenantId,
						requested.id,
					);
					if (run.status === 'failed') {
						throw new AuditServiceError(
							run.reason ?? 'EXPORT_FAILED',
							`The platform refused the export of ${workspace.slug}: ${run.reason ?? 'the run failed'}. The export history of the workspace records the run.`,
							412,
						);
					}
					const summary = run.summary;
					const incomplete = (summary?.exclusions ?? []).filter(
						(entry) => entry.reason === EXPORT_EXCLUSIONS.noOperation,
					);
					const unreachable = (summary?.exclusions ?? []).filter(
						(entry) => entry.reason === EXPORT_EXCLUSIONS.ownerNotComposed,
					);
					return {
						data: {
							moduleId: 'audit.core',
							applied: !run.dryRun,
							runId: run.id,
							workspace,
							archivePath: run.archivePath,
							archiveDigest: run.archiveDigest,
							complete: summary?.complete ?? false,
							classes: summary?.classes ?? [],
							exclusions: summary?.exclusions ?? [],
							truncated: summary?.truncated ?? false,
							totals: { classes: run.classes, rows: run.rows },
						},
						evidence: [
							SPEC_EVIDENCE,
							...(run.archivePath ? [run.archivePath] : []),
						],
						warnings: [
							...(incomplete.length === 0
								? []
								: [
										`EXPORT_INCOMPLETE: ${incomplete
											.map((entry) => entry.classId)
											.join(
												', ',
											)} have no export operation, so the owning module declared them but cannot hand their rows over. The archive records each one as an exclusion and manifest.complete is false.`,
									]),
							...(unreachable.length === 0
								? []
								: [
										`EXPORT_OWNER_MISSING: ${unreachable
											.map((entry) => entry.classId)
											.join(
												', ',
											)} have no composed owner in the running platform. Enable the owning module and request the export again.`,
									]),
						],
					};
				} finally {
					await runtime.dispose();
				}
			},
		},
		{
			path: ['audit', 'seal'],
			capability: capability('audit seal'),
			execute: async (context) => {
				const usage =
					'Use audit seal --workspace <slug|id> --output <dir> [--apply]';
				const workspace = await resolveWorkspace(
					context,
					stringFlag(context, 'workspace', usage),
				);
				const output = directoryFlag(context, 'output', usage);
				const runtime = operatorRuntime(context);
				try {
					/* Sealing reads and writes rows audit.core owns, so the operator
					   process performs it: no owner port is involved. */
					const seals = await runtime.seals();
					const result = await seals.seal({
						tenantId: workspace.tenantId,
						outputDirectory: output,
						sealedBy: operatorLabel(),
						apply: context.apply,
					});
					return {
						data: {
							moduleId: 'audit.core',
							applied: result.applied,
							workspace,
							segmentFile: result.segmentFile,
							segmentPath: result.segmentPath,
							fromSequence: result.plan.fromSequence,
							toSequence: result.plan.toSequence,
							rowCount: result.plan.rowCount,
							firstOccurredAt: iso(result.plan.firstOccurredAt),
							lastOccurredAt: iso(result.plan.lastOccurredAt),
							previousAnchorSequence:
								result.plan.previousAnchor?.anchorSequence ?? null,
							anchor: result.anchor
								? {
										anchorSequence: result.anchor.anchorSequence,
										anchorHash: result.anchor.anchorHash,
										segmentHash: result.anchor.segmentHash,
										keyId: result.anchor.keyId,
									}
								: null,
						},
						evidence: [
							SPEC_EVIDENCE,
							...(result.applied && result.segmentPath
								? [result.segmentPath]
								: []),
						],
						warnings: result.plan.truncated
							? [
									'SEAL_TRUNCATED: more events are waiting than one segment may close. Run the command again to seal the rest.',
								]
							: [],
					};
				} finally {
					await runtime.dispose();
				}
			},
		},
		{
			path: ['audit', 'verify'],
			capability: capability('audit verify'),
			execute: async (context) => {
				const usage = 'Use audit verify --workspace <slug|id> --input <dir>';
				const workspace = await resolveWorkspace(
					context,
					stringFlag(context, 'workspace', usage),
				);
				const input = directoryFlag(context, 'input', usage);
				const runtime = operatorRuntime(context);
				try {
					const report = await (
						await runtime.seals()
					).verify({ tenantId: workspace.tenantId, inputDirectory: input });
					const failures = [
						...report.chain.failures,
						...report.segments.flatMap((segment) => segment.failures),
					];
					if (!report.ok) {
						throw new AuditServiceError(
							'CHAIN_VERIFICATION_FAILED',
							`The audit chain of ${workspace.slug} does not verify: ${failures.join(' ')}`,
							409,
						);
					}
					return {
						data: {
							moduleId: 'audit.core',
							applied: false,
							workspace,
							directory: report.directory,
							segments: report.segments,
							chain: report.chain,
							totals: report.totals,
							window: report.window,
						},
						evidence: [SPEC_EVIDENCE, report.directory],
						warnings: [
							...(report.totals.plaintextEvents === 0
								? []
								: [
										`PLAINTEXT_EVENTS: ${report.totals.plaintextEvents} events in these segments name no event format, so they were written before audit.core sealed anything. Any of them that names a person carries the actor, the subject and the details in the clear, and destroying a subject key does not reach them.`,
									]),
							...(report.window.truncated
								? [
										`VERIFICATION_WINDOW: this pass read the newest ${report.window.files} segment files and the newest ${report.window.anchors} anchors, which is its window of ${report.window.limit}. Anything sealed before them was not checked; verify the older segments in a directory of their own.`,
									]
								: []),
						],
					};
				} finally {
					await runtime.dispose();
				}
			},
		},
		{
			path: ['audit', 'erase'],
			capability: capability('audit erase'),
			execute: async (context) => {
				const usage =
					'Use audit erase --workspace <slug|id> --account <id> --output <dir> [--apply --confirm erase-subject] [--destroy-key]';
				const workspace = await resolveWorkspace(
					context,
					stringFlag(context, 'workspace', usage),
				);
				const subject = stringFlag(context, 'account', usage);
				const output = directoryFlag(context, 'output', usage);
				/* The runner enforces a confirmation for destructive capabilities
				   only; this one is process risk by decision, so the command asks
				   for the token itself rather than removing a person's records on
				   an --apply that was meant for something else. */
				if (context.apply && context.flags.get('confirm') !== 'erase-subject') {
					throw new AuditServiceError(
						'CONFIRMATION_REQUIRED',
						'Pass --confirm erase-subject with --apply.',
					);
				}
				const destroyKey = context.flags.get('destroy-key') === true;
				const runtime = operatorRuntime(context);
				try {
					const erasures = await runtime.erasures();
					const repository = await runtime.repository();
					const requested = await erasures.request({
						tenantId: workspace.tenantId,
						subject,
						slug: workspace.slug,
						name: workspace.name,
						operator: operatorLabel(),
						outputDirectory: output,
						apply: context.apply,
						destroyKey,
						subjectMarker: erasureSubjectMarker(workspace.tenantId, subject),
					});
					const run = await awaitErasureRun(
						repository,
						workspace.tenantId,
						requested.id,
					);
					if (run.status === 'failed') {
						throw new AuditServiceError(
							run.reason ?? 'ERASURE_FAILED',
							`The platform refused the erasure in ${workspace.slug}: ${run.reason ?? 'the run failed'}. The erasure history of the workspace records the run.`,
							412,
						);
					}
					const outcome = run.outcome ?? [];
					const uncounted = outcome.filter((entry) => entry.rows === null);
					const failed = outcome.filter((entry) => entry.failure);
					return {
						data: {
							moduleId: 'audit.core',
							applied: !run.dryRun,
							runId: run.id,
							workspace,
							subjectMarker: run.subjectMarker,
							destroyKey: run.destroyKey,
							classes: outcome,
							totals: { classes: run.classes, rows: run.rows },
							certificatePath: run.certificatePath,
						},
						evidence: [
							SPEC_EVIDENCE,
							...(run.certificatePath ? [run.certificatePath] : []),
						],
						warnings: [
							...(uncounted.length === 0
								? []
								: [
										`ERASURE_COUNT_UNKNOWN: ${uncounted
											.map((entry) => entry.classId)
											.join(
												', ',
											)} answered no count, so the plan cannot say how many rows they hold.`,
									]),
							...(failed.length === 0
								? []
								: [
										`ERASURE_CLASS_FAILED: ${failed
											.map((entry) => entry.classId)
											.join(
												', ',
											)} could not be erased. The certificate records each failure; run the command again once the owning module answers.`,
									]),
						],
					};
				} finally {
					await runtime.dispose();
				}
			},
		},
		{
			path: ['audit', 'secrets-rotate'],
			capability: capability('audit secrets-rotate'),
			execute: async (context) => {
				const runtime = operatorRuntime(context);
				try {
					/* The report names key ids and anchor counts only; key material
					   never reaches the command output. */
					const report = await rotateAnchorSignatures({
						repository: await runtime.repository(),
						signer: anchorSignerFromEnvironment(
							process.env,
							context.workspaceRoot,
						),
						apply: context.apply,
					});
					return {
						data: { moduleId: 'audit.core', applied: context.apply, ...report },
						evidence: [SPEC_EVIDENCE, 'docs/operations.md'],
						warnings: [
							...(report.skipped > 0
								? [
										`${report.skipped} anchors were re-signed by another process while this ran and keep their own signature. Run the command again.`,
									]
								: []),
							...(report.unknownKeys.length === 0
								? []
								: [
										`ANCHOR_KEY_UNKNOWN: anchors signed under ${report.unknownKeys.join(', ')} cannot be re-signed, because neither FD_AUDIT_ANCHOR_KEY nor FD_AUDIT_ANCHOR_KEY_PREVIOUS holds that key. Put it back before retiring it.`,
									]),
							...(report.unverifiedCount === 0
								? []
								: [
										`ANCHOR_SIGNATURE_INVALID: ${report.unverifiedCount} anchors carry a signature that does not verify under the ring and were left untouched (${report.unverified.join(', ')}). Re-signing one would replace the evidence; verify the segments of those anchors before doing anything else.`,
									]),
						],
					};
				} finally {
					await runtime.dispose();
				}
			},
		},
		{
			path: ['audit', 'holds', 'list'],
			capability: capability('audit holds list'),
			execute: async (context) => {
				const workspace = await resolveWorkspace(
					context,
					stringFlag(
						context,
						'workspace',
						'Use audit holds list --workspace <slug|id> [--status active|lifted]',
					),
				);
				const runtime = operatorRuntime(context);
				try {
					const status = optionalFlag(context, 'status');
					const holds = await (
						await runtime.holds()
					).list(
						workspace.tenantId,
						status === undefined ? undefined : holdStatusOrUndefined(status),
					);
					return {
						data: {
							moduleId: 'audit.core',
							applied: false,
							workspace,
							holds,
						},
						evidence: [SPEC_EVIDENCE],
					};
				} finally {
					await runtime.dispose();
				}
			},
		},
		{
			path: ['audit', 'holds', 'place'],
			capability: capability('audit holds place'),
			execute: async (context) => {
				const usage =
					'Use audit holds place --workspace <slug|id> --scope <account|workspace|data-class|date-range> --reason <text> [--account <id>] [--class <id>] [--from <date>] [--to <date>] [--apply]';
				const workspace = await resolveWorkspace(
					context,
					stringFlag(context, 'workspace', usage),
				);
				const scopeKind = oneOf<HoldScopeKind>(
					stringFlag(context, 'scope', usage),
					'scope',
					HOLD_SCOPE_KINDS,
				);
				const reason = stringFlag(context, 'reason', usage);
				if (reason.length > HOLD_LIMITS.reason) {
					throw new AuditServiceError(
						'INVALID_INPUT',
						`--reason accepts at most ${HOLD_LIMITS.reason} characters.`,
					);
				}
				const input = {
					scopeKind,
					accountId: optionalFlag(context, 'account') ?? null,
					classId: optionalFlag(context, 'class') ?? null,
					fromAt: timestampFlag(context, 'from'),
					toAt: timestampFlag(context, 'to'),
					reason,
				};
				const runtime = operatorRuntime(context);
				try {
					const holds = await runtime.holds();
					if (!context.apply) {
						return {
							data: {
								moduleId: 'audit.core',
								applied: false,
								workspace,
								plan: input,
							},
							evidence: [SPEC_EVIDENCE],
						};
					}
					const hold = await holds.place(
						workspace.tenantId,
						operatorLabel(),
						input,
					);
					return {
						data: {
							moduleId: 'audit.core',
							applied: true,
							workspace,
							hold,
						},
						evidence: [SPEC_EVIDENCE],
					};
				} finally {
					await runtime.dispose();
				}
			},
		},
		{
			path: ['audit', 'holds', 'lift'],
			capability: capability('audit holds lift'),
			execute: async (context) => {
				const usage =
					'Use audit holds lift --workspace <slug|id> --hold <id> --reason <text> [--apply]';
				const workspace = await resolveWorkspace(
					context,
					stringFlag(context, 'workspace', usage),
				);
				const id = stringFlag(context, 'hold', usage);
				const reason = stringFlag(context, 'reason', usage);
				const runtime = operatorRuntime(context);
				try {
					const holds = await runtime.holds();
					if (!context.apply) {
						return {
							data: {
								moduleId: 'audit.core',
								applied: false,
								workspace,
								plan: { id, reason },
							},
							evidence: [SPEC_EVIDENCE],
						};
					}
					const hold = await holds.lift(workspace.tenantId, operatorLabel(), {
						id,
						reason,
					});
					return {
						data: {
							moduleId: 'audit.core',
							applied: true,
							workspace,
							hold,
						},
						evidence: [SPEC_EVIDENCE],
					};
				} finally {
					await runtime.dispose();
				}
			},
		},
	],
});

function iso(value: number | null): string | null {
	return value === null ? null : new Date(value).toISOString();
}

export default cliExtension;
