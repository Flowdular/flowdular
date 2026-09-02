import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
	readSession,
	sessionPaths,
	updateSession,
	type SandboxSession,
	type SessionAttachment,
} from './sessions.ts';
import { SandboxSetupError } from './workspace-root.ts';

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_NAME = 128;

interface AttachmentType {
	readonly kind: SessionAttachment['kind'];
	readonly contentType: string;
}

/* The only extensions accepted. Images are verified by magic bytes; the
   concept/text formats are accepted by extension, with a NUL-byte guard that
   rejects a binary wearing a text extension. */
const ATTACHMENT_TYPES: Readonly<Record<string, AttachmentType>> = {
	png: { kind: 'image', contentType: 'image/png' },
	jpg: { kind: 'image', contentType: 'image/jpeg' },
	jpeg: { kind: 'image', contentType: 'image/jpeg' },
	gif: { kind: 'image', contentType: 'image/gif' },
	webp: { kind: 'image', contentType: 'image/webp' },
	md: { kind: 'file', contentType: 'text/markdown; charset=utf-8' },
	txt: { kind: 'file', contentType: 'text/plain; charset=utf-8' },
	json: { kind: 'file', contentType: 'application/json; charset=utf-8' },
	csv: { kind: 'file', contentType: 'text/csv; charset=utf-8' },
	pdf: { kind: 'file', contentType: 'application/pdf' },
	svg: { kind: 'file', contentType: 'image/svg+xml' },
};

const ATTACHMENT_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* Attachment ids are the only client-chosen segment that reaches a file path,
   so anything that is not an id the sandbox minted is refused before a path is
   built from it. */
export function assertAttachmentId(value: string): string {
	if (!ATTACHMENT_ID.test(value)) {
		throw new SandboxSetupError(
			'INVALID_ATTACHMENT_ID',
			'The attachment id is not a sandbox attachment identifier.',
		);
	}
	return value;
}

function extensionOf(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/* The original filename reduced to a safe basename: no path segments, only
   [A-Za-z0-9._-], no `..` traversal, no leading dot, and bounded length with
   the extension preserved. */
function safeAttachmentName(raw: string): string {
	const base = raw.split(/[/\\]/).pop() ?? '';
	let safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '.');
	safe = safe.replace(/^\.+/, '');
	if (safe.length > MAX_ATTACHMENT_NAME) {
		const dot = safe.lastIndexOf('.');
		const ext = dot > 0 ? safe.slice(dot) : '';
		safe = safe.slice(0, Math.max(1, MAX_ATTACHMENT_NAME - ext.length)) + ext;
	}
	if (!safe || safe === '.' || safe.includes('..')) {
		throw new SandboxSetupError(
			'ATTACHMENT_NAME_INVALID',
			'The attachment filename is not a valid name.',
		);
	}
	return safe;
}

/* Images must prove their format; the pdf and svg formats carry a recognisable
   header too. Text formats are accepted by extension. */
function contentMatches(ext: string, bytes: Buffer): boolean {
	switch (ext) {
		case 'png':
			return (
				bytes.length >= 8 &&
				bytes[0] === 0x89 &&
				bytes[1] === 0x50 &&
				bytes[2] === 0x4e &&
				bytes[3] === 0x47
			);
		case 'jpg':
		case 'jpeg':
			return (
				bytes.length >= 3 &&
				bytes[0] === 0xff &&
				bytes[1] === 0xd8 &&
				bytes[2] === 0xff
			);
		case 'gif': {
			const head = bytes.subarray(0, 6).toString('latin1');
			return head === 'GIF87a' || head === 'GIF89a';
		}
		case 'webp':
			return (
				bytes.length >= 12 &&
				bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
				bytes.subarray(8, 12).toString('latin1') === 'WEBP'
			);
		case 'pdf':
			return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
		case 'svg': {
			const head = bytes.subarray(0, 4096).toString('utf8').trimStart();
			return head.startsWith('<') && /<svg[\s>]/i.test(head);
		}
		default:
			/* Text formats: reject a binary payload carrying a text extension. */
			return !bytes.subarray(0, 8192).includes(0);
	}
}

function resolveType(name: string, bytes: Buffer): AttachmentType {
	const ext = extensionOf(name);
	const type = ATTACHMENT_TYPES[ext];
	if (!type) {
		throw new SandboxSetupError(
			'ATTACHMENT_TYPE_REJECTED',
			`Attachments of type .${ext || '(none)'} are not allowed. Allowed: ${Object.keys(
				ATTACHMENT_TYPES,
			).join(', ')}.`,
		);
	}
	if (!contentMatches(ext, bytes)) {
		throw new SandboxSetupError(
			'ATTACHMENT_TYPE_REJECTED',
			`The file contents do not match a .${ext} file.`,
		);
	}
	return type;
}

export function attachmentContentType(name: string): string {
	return (
		ATTACHMENT_TYPES[extensionOf(name)]?.contentType ??
		'application/octet-stream'
	);
}

/* Two attachments must never share a workspace filename, or one would overwrite
   the other in reference/attachments/. */
function uniqueName(
	name: string,
	existing: readonly SessionAttachment[],
): string {
	const taken = new Set(existing.map((item) => item.name));
	if (!taken.has(name)) return name;
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : '';
	for (let index = 2; index < 1000; index += 1) {
		const candidate = `${stem}-${index}${ext}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${randomUUID().slice(0, 8)}-${name}`;
}

function assertInside(root: string, path: string): string {
	const inside = relative(resolve(root), resolve(path));
	if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
		throw new SandboxSetupError(
			'ATTACHMENT_NAME_INVALID',
			'The attachment path escapes the session directory.',
		);
	}
	return path;
}

function storedPath(
	paths: ReturnType<typeof sessionPaths>,
	meta: SessionAttachment,
): string {
	return assertInside(
		paths.attachments,
		join(paths.attachments, `${meta.id}-${meta.name}`),
	);
}

function workspacePath(
	paths: ReturnType<typeof sessionPaths>,
	meta: SessionAttachment,
): string {
	return assertInside(
		paths.workspaceAttachments,
		join(paths.workspaceAttachments, meta.name),
	);
}

export async function addAttachment(
	workspaceRoot: string,
	session: SandboxSession,
	input: { readonly name: string; readonly bytes: Buffer },
): Promise<SessionAttachment> {
	if (input.bytes.byteLength === 0) {
		throw new SandboxSetupError('ATTACHMENT_EMPTY', 'The attachment is empty.');
	}
	if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
		throw new SandboxSetupError(
			'ATTACHMENT_TOO_LARGE',
			`Attachments are limited to ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB.`,
		);
	}
	const current = await readSession(workspaceRoot, session.id);
	if (current.attachments.length >= MAX_ATTACHMENTS) {
		throw new SandboxSetupError(
			'ATTACHMENT_LIMIT_REACHED',
			`A session may hold at most ${MAX_ATTACHMENTS} attachments.`,
		);
	}
	const type = resolveType(input.name, input.bytes);
	const meta: SessionAttachment = {
		id: randomUUID(),
		name: uniqueName(safeAttachmentName(input.name), current.attachments),
		kind: type.kind,
		size: input.bytes.byteLength,
		addedAt: Date.now(),
	};
	const paths = sessionPaths(workspaceRoot, current.id, current.moduleSuffix);
	await mkdir(paths.attachments, { recursive: true });
	await mkdir(paths.workspaceAttachments, { recursive: true });
	await writeFile(storedPath(paths, meta), input.bytes);
	await writeFile(workspacePath(paths, meta), input.bytes);
	await updateSession(workspaceRoot, current.id, {
		attachments: [...current.attachments, meta],
	});
	return meta;
}

export async function listAttachments(
	workspaceRoot: string,
	session: SandboxSession,
): Promise<readonly SessionAttachment[]> {
	return (await readSession(workspaceRoot, session.id)).attachments;
}

function findAttachment(
	attachments: readonly SessionAttachment[],
	attachmentId: string,
): SessionAttachment {
	const meta = attachments.find((item) => item.id === attachmentId);
	if (!meta) {
		throw new SandboxSetupError(
			'ATTACHMENT_NOT_FOUND',
			'No such attachment exists in this session.',
		);
	}
	return meta;
}

export async function removeAttachment(
	workspaceRoot: string,
	session: SandboxSession,
	attachmentId: string,
): Promise<void> {
	assertAttachmentId(attachmentId);
	const current = await readSession(workspaceRoot, session.id);
	const meta = findAttachment(current.attachments, attachmentId);
	const paths = sessionPaths(workspaceRoot, current.id, current.moduleSuffix);
	await rm(storedPath(paths, meta), { force: true });
	await rm(workspacePath(paths, meta), { force: true });
	await updateSession(workspaceRoot, current.id, {
		attachments: current.attachments.filter((item) => item.id !== attachmentId),
	});
}

export async function readAttachment(
	workspaceRoot: string,
	session: SandboxSession,
	attachmentId: string,
): Promise<{
	readonly bytes: Buffer;
	readonly contentType: string;
	readonly name: string;
}> {
	assertAttachmentId(attachmentId);
	const current = await readSession(workspaceRoot, session.id);
	const meta = findAttachment(current.attachments, attachmentId);
	const paths = sessionPaths(workspaceRoot, current.id, current.moduleSuffix);
	const bytes = await readFile(storedPath(paths, meta));
	return {
		bytes,
		contentType: attachmentContentType(meta.name),
		name: meta.name,
	};
}

/* The note prepended to a turn's instruction when the session has attachments.
   The files are already in reference/attachments/, so the agent opens them with
   its normal file tools; the path plus this note is the whole contract. */
export function attachmentInstruction(
	attachments: readonly SessionAttachment[],
): string | null {
	if (attachments.length === 0) return null;
	const list = attachments
		.map((item) => `${item.name} (${item.kind})`)
		.join(', ');
	return `Attachments the operator provided (in reference/attachments/): ${list}. Screenshots show the desired change; read the files before implementing.`;
}
