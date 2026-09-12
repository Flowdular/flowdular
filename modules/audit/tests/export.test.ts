import { createHash } from 'node:crypto';
import {
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDataClassRegistry } from '@flowdular/kernel';
import {
	AUDIT_EVENT_ACTIONS,
	type AuditExportRun,
} from '../src/domain/types.ts';
import {
	AuditExportService,
	awaitExportRun,
	EXPORT_CLAIM_TIMEOUT_MS,
	EXPORT_EXCLUSIONS,
	EXPORT_FORMAT_VERSION,
	type ExportManifest,
} from '../src/services/export-service.ts';
import { AuditRetentionService } from '../src/services/retention-service.ts';
import {
	openAuditTestDatabase,
	type AuditTestDatabase,
} from './support/database.ts';
import {
	backupMissing,
	backupPresent,
	FakeOwnerModule,
} from './support/fake-modules.ts';
import { jsonLines, readStoredZip } from './support/zip-reader.ts';

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const ALPHA = 'tenant-alpha';
const BETA = 'tenant-beta';
/* The archive must land outside the workspace tree, so the deployment names an
   export directory the workspace root does not contain. */
const WORKSPACE_ROOT = join(tmpdir(), 'flowdular-audit-workspace');

let shared: AuditTestDatabase;
let output: string;

beforeAll(async () => {
	shared = await openAuditTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
	if (output) await rm(output, { recursive: true, force: true });
});

function owners(): readonly FakeOwnerModule[] {
	const runs = new FakeOwnerModule('agents.core', 'runs', [
		{
			tenantId: ALPHA,
			id: 'run-1',
			at: NOW - 1_000,
			payload: { status: 'succeeded' },
		},
		{
			tenantId: ALPHA,
			id: 'run-2',
			at: NOW - 2_000,
			/* A payload the owner sealed at rest and decrypted for the export. */
			payload: { status: 'failed', payload: 'decrypted workflow payload' },
		},
		{
			tenantId: BETA,
			id: 'run-9',
			at: NOW - 3_000,
			payload: { status: 'succeeded', secret: 'beta only' },
		},
	]);
	const credentials = new FakeOwnerModule('auth.core', 'credentials');
	return [runs, credentials];
}

interface Fixture {
	readonly runs: FakeOwnerModule;
	readonly service: AuditExportService;
	readonly request: (
		tenantId: string,
		apply: boolean,
	) => Promise<AuditExportRun>;
	/** Requests a run and lets one platform pass answer it. */
	readonly answered: (
		tenantId: string,
		apply: boolean,
	) => Promise<AuditExportRun>;
}

async function fixture(
	options: {
		readonly backup?: ReturnType<typeof backupPresent>;
		readonly directory?: string | undefined;
		readonly claimTimeoutMs?: number;
		readonly extra?: readonly FakeOwnerModule[];
	} = {},
): Promise<Fixture> {
	const [runs, credentials] = owners();
	const registry = createDataClassRegistry();
	registry.declare(runs!.moduleId, [runs!.declaration()]);
	registry.declare(credentials!.moduleId, [
		credentials!.declaration({
			key: 'credentials',
			label: 'Sign-in credentials',
			defaultRetentionDays: null,
			exportable: false,
			excludedReason: 'Password hashes and sealed secrets are never exported.',
			sweep: undefined,
			export: undefined,
		}),
	]);
	for (const owner of options.extra ?? []) {
		registry.declare(owner.moduleId, [
			owner.declaration({ export: undefined }),
		]);
	}
	registry.seal();
	/* Containment is decided on real paths, and the system temporary directory
	   is a symbolic link on macOS, so the directory a run records is the
	   resolved one. */
	output = await realpath(
		await mkdtemp(join(tmpdir(), 'flowdular-audit-export-')),
	);
	const retention = new AuditRetentionService(
		shared.repository,
		registry,
		() => NOW,
	);
	const service = new AuditExportService({
		repository: shared.repository,
		registry,
		retention,
		backup: options.backup ?? backupPresent(),
		environment:
			options.directory === undefined
				? { FD_AUDIT_EXPORT_DIRECTORY: output }
				: { FD_AUDIT_EXPORT_DIRECTORY: options.directory },
		workspaceRoot: WORKSPACE_ROOT,
		platformVersion: async () => '0.2.0',
		...(options.claimTimeoutMs === undefined
			? {}
			: { claimTimeoutMs: options.claimTimeoutMs }),
		now: () => NOW,
	});
	const request = (tenantId: string, apply: boolean) =>
		service.request({
			tenantId,
			slug: tenantId,
			name: tenantId,
			requestedBy: 'cli:operator',
			outputDirectory: output,
			apply,
		});
	return {
		runs: runs!,
		service,
		request,
		answered: async (tenantId, apply) => {
			const requested = await request(tenantId, apply);
			await service.tick();
			const settled = await shared.repository.getExportRun(
				tenantId,
				requested.id,
			);
			if (!settled) throw new Error('The export run vanished.');
			return settled;
		},
	};
}

describe('AUDIT-EXPORT', () => {
	it('records the request as a started run the platform has not answered yet', async () => {
		const { request } = await fixture();

		const run = await request(ALPHA, true);

		expect({
			status: run.status,
			dryRun: run.dryRun,
			outputDirectory: run.outputDirectory,
			requestedBy: run.requestedBy,
			archivePath: run.archivePath,
		}).toEqual({
			status: 'started',
			dryRun: false,
			outputDirectory: output,
			requestedBy: 'cli:operator',
			archivePath: null,
		});
		expect(await readdir(output)).toEqual([]);
	});

	it('writes a readable archive with a manifest and one JSON Lines file per class', async () => {
		const { runs, answered } = await fixture();

		const run = await answered(ALPHA, true);

		expect(run.status).toBe('completed');
		const archive = await readFile(run.archivePath!);
		const entries = readStoredZip(archive);
		expect(entries.map((entry) => entry.name).sort()).toEqual([
			'classes/agents.core.runs.jsonl',
			'manifest.json',
		]);
		const manifest = JSON.parse(
			entries
				.find((entry) => entry.name === 'manifest.json')!
				.data.toString('utf8'),
		) as ExportManifest;
		expect(manifest.classes.map((entry) => entry.file)).toEqual([
			'classes/agents.core.runs.jsonl',
		]);
		const rows = jsonLines(
			entries.find((entry) => entry.name.endsWith('agents.core.runs.jsonl'))!,
		);
		expect(rows.map((row) => row.id)).toEqual(['run-1', 'run-2']);
		expect(runs.exportCalls).toEqual([ALPHA]);
	});

	it('lists classes, counts, time ranges and exclusions with their declared reason', async () => {
		const { answered } = await fixture();

		const run = await answered(ALPHA, true);

		const manifest = JSON.parse(
			readStoredZip(await readFile(run.archivePath!))
				.find((entry) => entry.name === 'manifest.json')!
				.data.toString('utf8'),
		) as ExportManifest;
		expect(manifest.formatVersion).toBe(EXPORT_FORMAT_VERSION);
		expect(manifest.complete).toBe(true);
		expect(manifest.platformVersion).toBe('0.2.0');
		expect(manifest.workspace).toEqual({
			tenantId: ALPHA,
			slug: ALPHA,
			name: ALPHA,
		});
		expect(manifest.backup.keys.map((key) => key.variable)).toContain(
			'FD_AUTH_MFA_KEY',
		);
		const runs = manifest.classes.find(
			(entry) => entry.classId === 'agents.core.runs',
		)!;
		expect({ rows: runs.rows, from: runs.from, to: runs.to }).toEqual({
			rows: 2,
			from: new Date(NOW - 2_000).toISOString(),
			to: new Date(NOW - 1_000).toISOString(),
		});
		expect(manifest.exclusions).toEqual([
			{
				classId: 'auth.core.credentials',
				moduleId: 'auth.core',
				label: 'Sign-in credentials',
				reason: EXPORT_EXCLUSIONS.declared,
				declaredReason:
					'Password hashes and sealed secrets are never exported.',
			},
		]);
	});

	it('never carries a row of another workspace', async () => {
		const { answered } = await fixture();

		const run = await answered(ALPHA, true);

		const archive = await readFile(run.archivePath!);
		expect(archive.toString('utf8')).not.toContain('beta only');
		expect(archive.toString('utf8')).not.toContain('run-9');
	});

	it('writes the archive with owner-only modes', async () => {
		const { answered } = await fixture();

		const run = await answered(ALPHA, true);

		expect((await stat(run.archivePath!)).mode & 0o777).toBe(0o600);
	});

	it('records the run with the digest and the summary of the file that was written', async () => {
		const { answered } = await fixture();

		const run = await answered(ALPHA, true);

		const archive = await readFile(run.archivePath!);
		expect(run.archiveDigest).toBe(
			createHash('sha256').update(archive).digest('hex'),
		);
		expect({
			status: run.status,
			dryRun: run.dryRun,
			classes: run.classes,
			rows: run.rows,
			reason: run.reason,
			requestedBy: run.requestedBy,
		}).toEqual({
			status: 'completed',
			dryRun: false,
			classes: 1,
			rows: 2,
			reason: null,
			requestedBy: 'cli:operator',
		});
		expect(run.summary).toEqual({
			complete: true,
			truncated: false,
			classes: [
				{
					classId: 'agents.core.runs',
					rows: 2,
					from: new Date(NOW - 2_000).toISOString(),
					to: new Date(NOW - 1_000).toISOString(),
				},
			],
			exclusions: [
				{
					classId: 'auth.core.credentials',
					reason: EXPORT_EXCLUSIONS.declared,
				},
			],
		});
	});

	it('writes an audit event before it starts and when it completes', async () => {
		const { answered } = await fixture();

		const run = await answered(ALPHA, true);

		const events = (await shared.repository.listAuditEvents(ALPHA, 20)).filter(
			(event) => event.subjectType === 'export-run',
		);
		expect(events.map((event) => event.action)).toEqual([
			AUDIT_EVENT_ACTIONS.exportCompleted,
			AUDIT_EVENT_ACTIONS.exportStarted,
		]);
		expect(events.every((event) => event.subjectId === run.id)).toBe(true);
	});

	it('records the run as failed and leaves no archive behind when an owner export fails', async () => {
		const { runs, answered } = await fixture();
		runs.failExport = true;

		const run = await answered(ALPHA, true);

		expect([run.status, run.reason]).toEqual(['failed', 'OWNER_EXPORT_FAILED']);
		expect(await readdir(output)).toEqual([]);
	});

	it('reports a class whose owner declared no export operation as an incomplete archive', async () => {
		const { answered } = await fixture({
			extra: [new FakeOwnerModule('workflows.core', 'run-payloads')],
		});

		const run = await answered(ALPHA, true);

		expect(run.summary?.complete).toBe(false);
		expect(run.summary?.exclusions).toContainEqual({
			classId: 'workflows.core.run-payloads',
			reason: EXPORT_EXCLUSIONS.noOperation,
		});
	});
});

describe('the export directory the deployment allows', () => {
	it('refuses a request while no export directory is configured', async () => {
		const { request } = await fixture({ directory: '' });

		await expect(request(ALPHA, true)).rejects.toMatchObject({
			code: 'EXPORT_DIRECTORY_NOT_CONFIGURED',
		});
		expect(
			await shared.repository.listExportRuns(ALPHA, undefined, 10),
		).toEqual([]);
	});

	it('refuses an output outside the configured directory', async () => {
		const { service } = await fixture();

		await expect(
			service.request({
				tenantId: ALPHA,
				requestedBy: 'cli:operator',
				outputDirectory: tmpdir(),
				apply: true,
			}),
		).rejects.toMatchObject({ code: 'EXPORT_OUTPUT_NOT_ALLOWED' });
	});

	it('refuses a relative output', async () => {
		const { service } = await fixture();

		await expect(
			service.request({
				tenantId: ALPHA,
				requestedBy: 'cli:operator',
				outputDirectory: 'exports',
				apply: true,
			}),
		).rejects.toMatchObject({ code: 'EXPORT_OUTPUT_REQUIRED' });
	});

	it('refuses a directory inside the workspace tree', async () => {
		const inside = join(WORKSPACE_ROOT, 'exports');
		const { service } = await fixture({ directory: inside });

		await expect(
			service.request({
				tenantId: ALPHA,
				requestedBy: 'cli:operator',
				outputDirectory: inside,
				apply: true,
			}),
		).rejects.toMatchObject({ code: 'EXPORT_OUTPUT_INSIDE_WORKSPACE' });
	});
});

describe('AUDIT-EXPORT-DRY-RUN', () => {
	it('answers the plan with the classes and counts and writes nothing', async () => {
		const { answered } = await fixture();

		const run = await answered(ALPHA, false);

		expect({
			status: run.status,
			dryRun: run.dryRun,
			classes: run.classes,
			rows: run.rows,
			archivePath: run.archivePath,
			archiveDigest: run.archiveDigest,
		}).toEqual({
			status: 'completed',
			dryRun: true,
			classes: 1,
			rows: 2,
			archivePath: null,
			archiveDigest: null,
		});
		expect(
			run.summary?.classes.map((entry) => [entry.classId, entry.rows]),
		).toEqual([['agents.core.runs', 2]]);
		expect(await readdir(output)).toEqual([]);
	});
});

describe('one run, one platform process', () => {
	it('leaves a run another process holds alone', async () => {
		const { request, service } = await fixture();
		const run = await request(ALPHA, true);
		await shared.repository.claimExportRun({
			tenantId: ALPHA,
			id: run.id,
			claimedAt: NOW,
			staleBefore: NOW - EXPORT_CLAIM_TIMEOUT_MS,
		});

		expect(await service.tick()).toEqual({
			examined: 1,
			completed: 0,
			failed: 0,
		});
		expect(await readdir(output)).toEqual([]);
		expect((await shared.repository.getExportRun(ALPHA, run.id))?.status).toBe(
			'started',
		);
	});

	it('takes a run over from a process that stopped holding it', async () => {
		const { request, service } = await fixture();
		const run = await request(ALPHA, true);
		await shared.repository.claimExportRun({
			tenantId: ALPHA,
			id: run.id,
			claimedAt: NOW - EXPORT_CLAIM_TIMEOUT_MS - 1,
			staleBefore: NOW - EXPORT_CLAIM_TIMEOUT_MS,
		});

		expect(await service.tick()).toEqual({
			examined: 1,
			completed: 1,
			failed: 0,
		});
		expect((await shared.repository.getExportRun(ALPHA, run.id))?.status).toBe(
			'completed',
		);
	});
});

describe('waiting for the platform to answer', () => {
	it('answers with the run the platform completed', async () => {
		const { request, service } = await fixture();
		const requested = await request(ALPHA, true);

		const run = await awaitExportRun(shared.repository, ALPHA, requested.id, {
			pollMs: 0,
			sleep: async () => {
				await service.tick();
			},
		});

		expect([run.status, run.rows]).toEqual(['completed', 2]);
	});

	it('stops waiting with a stable reason when nothing answers the run', async () => {
		const { request } = await fixture();
		const requested = await request(ALPHA, true);
		let clock = 0;

		await expect(
			awaitExportRun(shared.repository, ALPHA, requested.id, {
				timeoutMs: 10,
				pollMs: 0,
				now: () => (clock += 6),
				sleep: async () => undefined,
			}),
		).rejects.toMatchObject({ code: 'EXPORT_NOT_ANSWERED' });
	});
});

describe('AUDIT-SWEEP-NO-BACKUP (export half)', () => {
	it('refuses the export with a stable reason and writes no archive', async () => {
		const { answered } = await fixture({ backup: backupMissing() });

		const run = await answered(ALPHA, true);

		expect([run.status, run.reason, run.rows, run.classes]).toEqual([
			'failed',
			'BACKUP_MANIFEST_MISSING',
			0,
			0,
		]);
		expect(await readdir(output)).toEqual([]);
		const events = await shared.repository.listAuditEvents(ALPHA, 10);
		expect([events[0]?.action, events[0]?.metadata.reason]).toEqual([
			AUDIT_EVENT_ACTIONS.exportFailed,
			'BACKUP_MANIFEST_MISSING',
		]);
	});

	it('refuses the plan as well', async () => {
		const { answered } = await fixture({ backup: backupMissing() });

		const run = await answered(ALPHA, false);

		expect([run.status, run.reason]).toEqual([
			'failed',
			'BACKUP_MANIFEST_MISSING',
		]);
		expect(await readdir(output)).toEqual([]);
	});
});
