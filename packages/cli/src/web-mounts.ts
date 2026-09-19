import { readFile } from 'node:fs/promises';
import { RESERVED_WEB_SEGMENTS, WEB_MOUNT_PATH } from '@flowdular/contracts';
import type { WebMount } from '@flowdular/contracts';
import {
	enabledModules,
	syncPlatformModules,
	writeProjectConfig,
} from './module-sync.ts';
import type { Workspace } from './workspace.ts';

/**
 * Where a module's public pages answer. A surface is code the module owns; the
 * address it answers at is the operator's, which is why it lives in
 * flowdular.json rather than in the module, and why it names the workspace the
 * pages read.
 */
const MOUNT_ID = /^[a-z][a-z0-9-]*$/;
const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const MAX_MOUNTS = 256;

export interface MountRequest {
	readonly moduleId: string;
	readonly surfaceId: string;
	readonly path: string;
	readonly tenantId: string;
	readonly id?: string;
}

export interface MountReport {
	readonly mounts: readonly WebMount[];
	readonly mount: WebMount;
	readonly applied: boolean;
	readonly replaced: boolean;
}

export interface UnmountReport {
	readonly mounts: readonly WebMount[];
	readonly removed: WebMount;
	readonly applied: boolean;
}

export function currentMounts(workspace: Workspace): readonly WebMount[] {
	const web = workspace.config.web as { mounts?: unknown } | undefined;
	const mounts = web?.mounts;
	return Array.isArray(mounts) ? (mounts as WebMount[]) : [];
}

function applicationPath(workspace: Workspace): string {
	const application = workspace.config.application as
		| { path?: string }
		| undefined;
	return application?.path ?? '/app';
}

function within(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(prefix + '/');
}

/**
 * The mount a request describes, refused with the reason rather than written
 * wrong. Everything here is what the platform would refuse at boot, asked
 * before the file is touched so a typo costs a sentence instead of a
 * deployment that answers 404.
 */
export function planMount(
	workspace: Workspace,
	request: MountRequest,
): MountReport {
	const existing = currentMounts(workspace);
	if (!MODULE_ID.test(request.moduleId))
		throw new Error(`Invalid module id: ${request.moduleId}`);
	if (!MOUNT_ID.test(request.surfaceId))
		throw new Error(`Invalid surface id: ${request.surfaceId}`);
	const id = request.id ?? request.moduleId.split('.')[0]!;
	if (!MOUNT_ID.test(id)) throw new Error(`Invalid mount id: ${id}`);
	if (!request.tenantId.trim() || request.tenantId.length > 128)
		throw new Error(
			'Name the workspace this site serves with --tenant. It is the tenant id the pages read, and a mount carries no authority of its own.',
		);
	if (!WEB_MOUNT_PATH.test(request.path) || request.path.length > 256)
		throw new Error(
			`Invalid mount path: ${request.path}. Use / or lower-case segments such as /blog.`,
		);
	const segment = request.path.split('/')[1];
	if (segment && RESERVED_WEB_SEGMENTS.includes(segment))
		throw new Error(
			`The application answers on /${segment}; a site cannot take it. Reserved: ${RESERVED_WEB_SEGMENTS.join(', ')}.`,
		);
	if (within(request.path, applicationPath(workspace)))
		throw new Error(
			`The workspace shell answers on ${applicationPath(workspace)}; a site cannot take it.`,
		);
	if (!enabledModules(workspace).includes(request.moduleId))
		throw new Error(
			`${request.moduleId} is not enabled in this workspace. Run "flowdular module enable ${request.moduleId} --apply" first.`,
		);
	const others = existing.filter((mount) => mount.id !== id);
	if (others.length + 1 > MAX_MOUNTS)
		throw new Error(`A workspace holds at most ${MAX_MOUNTS} mounts.`);
	for (const other of others) {
		if (within(request.path, other.path) || within(other.path, request.path))
			throw new Error(
				`${other.id} already answers on ${other.path}, which overlaps ${request.path}.`,
			);
	}
	const mount: WebMount = {
		id,
		moduleId: request.moduleId,
		surfaceId: request.surfaceId,
		path: request.path,
		tenantId: request.tenantId,
	};
	return {
		mounts: [...others, mount].sort((left, right) =>
			left.id.localeCompare(right.id),
		),
		mount,
		replaced: others.length !== existing.length,
		applied: false,
	};
}

export function planUnmount(workspace: Workspace, id: string): UnmountReport {
	const existing = currentMounts(workspace);
	const removed = existing.find((mount) => mount.id === id);
	if (!removed) throw new Error(`No mount with id ${id}.`);
	return {
		mounts: existing.filter((mount) => mount.id !== id),
		removed,
		applied: false,
	};
}

/* The generated composition carries the mounts, so writing the configuration
   without regenerating it would leave the application serving the old set. */
export async function writeMounts(
	workspace: Workspace,
	mounts: readonly WebMount[],
): Promise<void> {
	const config = JSON.parse(
		await readFile(workspace.configPath, 'utf8'),
	) as Record<string, unknown>;
	if (mounts.length === 0) delete config.web;
	else config.web = { ...(config.web as object | undefined), mounts };
	await writeProjectConfig(workspace, config);
	await syncPlatformModules({ ...workspace, config }, true);
}
