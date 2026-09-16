import type { DataClassDeclaration } from '@flowdular/kernel';
import type { AdaptersRepository } from './repository.ts';

export const ADAPTER_RUN_RETENTION_DAYS = 90;
export const ADAPTER_RUN_ROW_RETENTION_DAYS = 30;

/**
 * The repository arrives as a thunk because declaring happens while the
 * platform composes, before anything has opened a database. Runs are swept
 * with their rows; the rows of a run go sooner on their own period. Bindings
 * and the audit trail are configuration and its history, kept until a person
 * deletes them. Erasure empties the account column and keeps every row.
 */
export function adaptersDataClasses(
	repository: () => Promise<AdaptersRepository>,
): readonly DataClassDeclaration[] {
	return [
		{
			key: 'run-rows',
			label: 'Data adapter run rows',
			defaultRetentionDays: ADAPTER_RUN_ROW_RETENTION_DAYS,
			exportable: true,
			sweep: async ({ tenantId, cutoff, limit }) => ({
				removed: await (
					await repository()
				).sweepRunRows(tenantId, cutoff.getTime(), limit),
			}),
			export: async ({ tenantId, sink }) =>
				(await repository()).exportRunRows(tenantId, sink),
		},
		{
			key: 'runs',
			label: 'Data adapter runs',
			defaultRetentionDays: ADAPTER_RUN_RETENTION_DAYS,
			exportable: true,
			sweep: async ({ tenantId, cutoff, limit }) => ({
				removed: await (
					await repository()
				).sweepRuns(tenantId, cutoff.getTime(), limit),
			}),
			export: async ({ tenantId, sink }) =>
				(await repository()).exportRuns(tenantId, sink),
			erase: async ({ tenantId, subject, limit }) => ({
				removed: 0,
				redacted: await (
					await repository()
				).eraseAccount('runs', tenantId, subject.accountId, limit),
			}),
			count: async ({ tenantId, subject }) =>
				(await repository()).countAccount('runs', tenantId, subject.accountId),
		},
		{
			key: 'bindings',
			label: 'Data adapter bindings',
			defaultRetentionDays: null,
			exportable: true,
			export: async ({ tenantId, sink }) =>
				(await repository()).exportBindings(tenantId, sink),
			erase: async ({ tenantId, subject, limit }) => ({
				removed: 0,
				redacted: await (
					await repository()
				).eraseAccount('bindings', tenantId, subject.accountId, limit),
			}),
			count: async ({ tenantId, subject }) =>
				(await repository()).countAccount(
					'bindings',
					tenantId,
					subject.accountId,
				),
		},
		{
			key: 'audit',
			label: 'Data adapter audit trail',
			defaultRetentionDays: null,
			exportable: true,
			export: async ({ tenantId, sink }) =>
				(await repository()).exportAudit(tenantId, sink),
			erase: async ({ tenantId, subject, limit }) => ({
				removed: 0,
				redacted: await (
					await repository()
				).eraseAccount('audit', tenantId, subject.accountId, limit),
			}),
			count: async ({ tenantId, subject }) =>
				(await repository()).countAccount('audit', tenantId, subject.accountId),
		},
	];
}
