import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRouter } from '@octanejs/app-core';
import {
	DEFAULT_AGENT_ROLES,
	createCodingAgentRegistry,
	type CodingAgentDriver,
	type CodingAgentTurnRequest,
} from '@flowdular/coding-agent';
import {
	MAX_ATTACHMENTS,
	MAX_ATTACHMENT_BYTES,
	addAttachment,
	assertAttachmentId,
	attachmentInstruction,
	listAttachments,
	readAttachment,
	removeAttachment,
} from '../src/server/attachments.ts';
import { DEFAULT_CONFIGURATION } from '../src/server/config.ts';
import type { PreviewRuntime } from '../src/server/preview-runtime.ts';
import { createSandboxRoutes } from '../src/server/routes.ts';
import type { SandboxRuntime } from '../src/server/runtime.ts';
import {
	createSession,
	readChat,
	readSession,
	sessionPaths,
} from '../src/server/sessions.ts';

/* A 1x1 PNG; its bytes begin with the PNG signature, so the magic-byte sniff
   accepts it. */
const PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-attachments-'));
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
		'utf8',
	);
	return root;
}

async function sessionFor(root: string) {
	return createSession({
		workspaceRoot: root,
		kind: 'new-module',
		moduleId: 'booking.core',
		title: 'Room booking',
		brief: 'Let people book meeting rooms.',
		blueprint: 'new-module@1.0.0',
		role: 'backend-engineer',
		driver: 'fake',
		install: false,
	});
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/* A driver that records the prompt it was handed and ends without touching the
   workspace, so no gates run and the turn is fast. */
function capturingDriver(sink: { prompt: string }): CodingAgentDriver {
	return {
		id: 'fake',
		label: 'Fake',
		kind: 'byok',
		requiresLoopback: false,
		description: 'test driver',
		probe: async () => ({ available: true, detail: 'ok', version: '1' }),
		async *run(request: CodingAgentTurnRequest) {
			sink.prompt = request.prompt;
			yield {
				type: 'turn.started',
				driver: 'fake',
				role: request.role,
				resumeId: null,
			};
			yield {
				type: 'assistant.message',
				text: 'Done.\n\nHANDOFF: none - done',
			};
			yield {
				type: 'turn.completed',
				resumeId: null,
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				costUsd: null,
				finishReason: 'stop',
			};
		},
	};
}

function fakeRuntime(root: string, driver: CodingAgentDriver): SandboxRuntime {
	const configuration = {
		...DEFAULT_CONFIGURATION,
		mode: 'loopback' as const,
		driver: driver.id,
	};
	const registry = createCodingAgentRegistry({
		mode: 'loopback',
		drivers: [driver],
	});
	const authority = {
		principal: {
			accountId: 'a',
			tenantId: 't',
			email: 'o@example.test',
			displayName: 'Owner',
			role: 'owner',
			scopes: [],
			tenantName: 'Tenant',
			tenantSlug: 'tenant',
		},
		authority: {
			granted: true as const,
			grantId: 'g',
			capabilities: ['sandbox.access.use'],
			expiresAt: null,
		},
	};
	return {
		workspaceRoot: root,
		configuration: () => configuration,
		registry: () => registry,
		roles: () => DEFAULT_AGENT_ROLES,
		platform: () => null,
		connection: () => ({ connected: true, authority, error: null }),
		refresh: async () => ({ connected: true, authority, error: null }),
		update: async () => ({ connected: true, authority, error: null }),
		openBrowserSession: async () => {
			throw new Error('not used');
		},
		browserSession: () => null,
		closeBrowserSession: () => undefined,
	};
}

const preview: PreviewRuntime = {
	compose: () => Promise.reject(new Error('no preview in tests')),
	cached: () => null,
	forget: () => undefined,
	dispose: () => undefined,
};

function api(runtime: SandboxRuntime, port = 4320) {
	const routes = createSandboxRoutes(runtime, preview, { port });
	const router = createRouter([...routes]);
	return async (
		method: string,
		path: string,
		init: { readonly body?: unknown } = {},
	): Promise<Response> => {
		const url = new URL(path, 'http://127.0.0.1:4320');
		const headers: Record<string, string> = { host: '127.0.0.1:4320' };
		if (init.body !== undefined) {
			headers['content-type'] = 'application/json';
			headers['x-flowdular-sandbox'] = '1';
		}
		const request = new Request(url, {
			method,
			headers,
			...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
		});
		const match = router.match(method, url.pathname);
		if (!match || match.route.type !== 'server') {
			return new Response('no route', { status: 404 });
		}
		return match.route.handler({
			request,
			params: match.params,
			url,
			state: new Map(),
		});
	};
}

async function readSse(response: Response): Promise<{ event: string }[]> {
	const text = await response.text();
	return text
		.split('\n\n')
		.filter(Boolean)
		.map((block) => ({ event: /^event: (.+)$/m.exec(block)?.[1] ?? '' }));
}

describe('attachment storage', () => {
	it('stores the bytes under the session and copies them into the workspace', async () => {
		const root = await workspace();
		const session = await sessionFor(root);
		const meta = await addAttachment(root, session, {
			name: 'screenshot.png',
			bytes: PNG_BYTES,
		});
		expect(meta).toMatchObject({
			name: 'screenshot.png',
			kind: 'image',
			size: PNG_BYTES.byteLength,
		});
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		expect(
			await exists(join(paths.attachments, `${meta.id}-screenshot.png`)),
		).toBe(true);
		expect(
			await exists(join(paths.workspaceAttachments, 'screenshot.png')),
		).toBe(true);
		expect(
			(await listAttachments(root, session)).map((item) => item.id),
		).toEqual([meta.id]);
	});

	it('serves the bytes back with the right content type', async () => {
		const root = await workspace();
		const session = await sessionFor(root);
		const meta = await addAttachment(root, session, {
			name: 'shot.png',
			bytes: PNG_BYTES,
		});
		const served = await readAttachment(root, session, meta.id);
		expect(served.contentType).toBe('image/png');
		expect(served.name).toBe('shot.png');
		expect(Buffer.compare(served.bytes, PNG_BYTES)).toBe(0);
	});

	it('rejects a file over the size limit', async () => {
		const root = await workspace();
		const session = await sessionFor(root);
		await expect(
			addAttachment(root, session, {
				name: 'big.png',
				bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x89),
			}),
		).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
	});

	it('rejects a disallowed extension', async () => {
		const root = await workspace();
		const session = await sessionFor(root);
		await expect(
			addAttachment(root, session, { name: 'evil.exe', bytes: PNG_BYTES }),
		).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_REJECTED' });
	});

	it('rejects contents that do not match the image extension', async () => {
		const root = await workspace();
		const session = await sessionFor(root);
		await expect(
			addAttachment(root, session, {
				name: 'notreally.png',
				bytes: Buffer.from('this is plain text, not a png'),
			}),
		).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_REJECTED' });
	});

	it('rejects the eleventh attachment', async () => {
		const root = await workspace();
		const session = await sessionFor(root);
		for (let index = 0; index < MAX_ATTACHMENTS; index += 1) {
			await addAttachment(root, session, {
				name: `s${index}.png`,
				bytes: PNG_BYTES,
			});
		}
		await expect(
			addAttachment(root, session, {
				name: 'one-too-many.png',
				bytes: PNG_BYTES,
			}),
		).rejects.toMatchObject({ code: 'ATTACHMENT_LIMIT_REACHED' });
	});

	it('sanitises a traversal filename to a safe basename that stays inside the session', async () => {
		const root = await workspace();
		const session = await sessionFor(root);
		const meta = await addAttachment(root, session, {
			name: '../../etc/passwd.png',
			bytes: PNG_BYTES,
		});
		expect(meta.name).toBe('passwd.png');
		expect(meta.name).not.toContain('/');
		expect(meta.name).not.toContain('..');
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		expect(await exists(join(paths.attachments, `${meta.id}-passwd.png`))).toBe(
			true,
		);
	});

	it('gives colliding filenames a unique workspace name', async () => {
		const root = await workspace();
		const session = await sessionFor(root);
		const first = await addAttachment(root, session, {
			name: 'same.png',
			bytes: PNG_BYTES,
		});
		const second = await addAttachment(root, session, {
			name: 'same.png',
			bytes: PNG_BYTES,
		});
		expect(first.name).toBe('same.png');
		expect(second.name).not.toBe('same.png');
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		expect(await exists(join(paths.workspaceAttachments, first.name))).toBe(
			true,
		);
		expect(await exists(join(paths.workspaceAttachments, second.name))).toBe(
			true,
		);
	});

	it('refuses a non-uuid attachment id before touching the disk', async () => {
		const root = await workspace();
		const session = await sessionFor(root);
		expect(() => assertAttachmentId('../../secret')).toThrow(
			/INVALID_ATTACHMENT_ID|identifier/,
		);
		await expect(
			readAttachment(root, session, '..%2f..'),
		).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_ID' });
		await expect(
			removeAttachment(root, session, 'not-a-uuid'),
		).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_ID' });
	});

	it('removes an attachment from disk, the workspace and the record', async () => {
		const root = await workspace();
		const session = await sessionFor(root);
		const meta = await addAttachment(root, session, {
			name: 'gone.png',
			bytes: PNG_BYTES,
		});
		await removeAttachment(root, session, meta.id);
		const paths = sessionPaths(root, session.id, session.moduleSuffix);
		expect(await exists(join(paths.attachments, `${meta.id}-gone.png`))).toBe(
			false,
		);
		expect(await exists(join(paths.workspaceAttachments, 'gone.png'))).toBe(
			false,
		);
		expect(await listAttachments(root, session)).toEqual([]);
	});
});

describe('attachment instruction', () => {
	it('is null with no attachments and lists names and kinds otherwise', () => {
		expect(attachmentInstruction([])).toBeNull();
		const note = attachmentInstruction([
			{ id: 'a', name: 'shot.png', kind: 'image', size: 1, addedAt: 0 },
			{ id: 'b', name: 'concept.md', kind: 'file', size: 1, addedAt: 0 },
		]);
		expect(note).toContain('reference/attachments/');
		expect(note).toContain('shot.png (image)');
		expect(note).toContain('concept.md (file)');
	});
});

describe('attachment routes', () => {
	it('uploads, serves, lists in the session view, and deletes', async () => {
		const root = await workspace();
		const runtime = fakeRuntime(root, capturingDriver({ prompt: '' }));
		const call = api(runtime);
		const session = await sessionFor(root);

		const created = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/attachments`,
			{
				body: { name: 'diagram.png', contentBase64: PNG_BASE64 },
			},
		);
		expect(created.status).toBe(201);
		const { attachment } = (await created.json()) as {
			attachment: { id: string; name: string; kind: string };
		};
		expect(attachment).toMatchObject({ name: 'diagram.png', kind: 'image' });

		const served = await call(
			'GET',
			`/sandbox/api/sessions/${session.id}/attachments/${attachment.id}`,
		);
		expect(served.status).toBe(200);
		expect(served.headers.get('content-type')).toBe('image/png');
		expect(served.headers.get('content-disposition')).toContain('inline');
		expect(served.headers.get('cache-control')).toBe('private, no-store');
		expect(Buffer.from(await served.arrayBuffer())).toEqual(PNG_BYTES);

		const view = (await (
			await call('GET', `/sandbox/api/sessions/${session.id}`)
		).json()) as { session: { attachments: { id: string }[] } };
		expect(view.session.attachments.map((item) => item.id)).toEqual([
			attachment.id,
		]);

		const removed = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/attachments/${attachment.id}/delete`,
			{ body: {} },
		);
		expect(removed.status).toBe(200);
		const after = (await (
			await call('GET', `/sandbox/api/sessions/${session.id}`)
		).json()) as { session: { attachments: unknown[] } };
		expect(after.session.attachments).toEqual([]);
	});

	it('refuses a traversal attachment id on serve and delete', async () => {
		const root = await workspace();
		const call = api(fakeRuntime(root, capturingDriver({ prompt: '' })));
		const session = await sessionFor(root);
		const served = await call(
			'GET',
			`/sandbox/api/sessions/${session.id}/attachments/%2e%2e%2fsecret`,
		);
		expect(served.status).toBe(400);
		expect(
			((await served.json()) as { error: { code: string } }).error.code,
		).toBe('INVALID_ATTACHMENT_ID');
		const deleted = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/attachments/not-a-uuid/delete`,
			{ body: {} },
		);
		expect(deleted.status).toBe(400);
	});

	it('rejects a disallowed type and an oversized payload over the wire', async () => {
		const root = await workspace();
		const call = api(fakeRuntime(root, capturingDriver({ prompt: '' })));
		const session = await sessionFor(root);
		const badType = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/attachments`,
			{
				body: { name: 'run.exe', contentBase64: PNG_BASE64 },
			},
		);
		expect(badType.status).toBe(415);
		const tooLarge = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/attachments`,
			{
				body: {
					name: 'huge.png',
					contentBase64: 'A'.repeat(
						Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 8,
					),
				},
			},
		);
		expect(tooLarge.status).toBe(413);
	});

	/* What the new-session screen does: create the session, upload what the
	   operator attached to the brief, then start the first turn. */
	it('carries files attached to a brief into the session the create call made', async () => {
		const root = await workspace();
		const sink = { prompt: '' };
		const call = api(fakeRuntime(root, capturingDriver(sink)));
		const created = (await (
			await call('POST', '/sandbox/api/sessions', {
				body: {
					brief: 'A screen where a user changes their display name.',
					driver: 'fake',
				},
			})
		).json()) as { session: { id: string } };
		const sessionId = created.session.id;

		const upload = await call(
			'POST',
			`/sandbox/api/sessions/${sessionId}/attachments`,
			{ body: { name: 'concept.png', contentBase64: PNG_BASE64 } },
		);
		expect(upload.status).toBe(201);

		const events = await readSse(
			await call('POST', `/sandbox/api/sessions/${sessionId}/turn`, {
				body: {
					message: 'A screen where a user changes their display name.',
					role: 'auto',
					driver: 'fake',
				},
			}),
		);
		expect(events.at(-1)?.event).toBe('ended');
		expect(sink.prompt).toContain('concept.png (image)');

		const session = await readSession(root, sessionId);
		expect(session.attachments.map((item) => item.name)).toEqual([
			'concept.png',
		]);
		const paths = sessionPaths(root, sessionId, session.moduleSuffix);
		expect(await exists(join(paths.workspaceAttachments, 'concept.png'))).toBe(
			true,
		);
	});

	it('keeps the created session when one of its attachments is refused', async () => {
		const root = await workspace();
		const sink = { prompt: '' };
		const call = api(fakeRuntime(root, capturingDriver(sink)));
		const created = (await (
			await call('POST', '/sandbox/api/sessions', {
				body: { brief: 'Let people book meeting rooms.', driver: 'fake' },
			})
		).json()) as { session: { id: string } };
		const sessionId = created.session.id;

		const refused = await call(
			'POST',
			`/sandbox/api/sessions/${sessionId}/attachments`,
			{
				body: {
					name: 'payload.exe',
					contentBase64: Buffer.from('MZ').toString('base64'),
				},
			},
		);
		expect(refused.status).toBe(415);
		const session = await readSession(root, sessionId);
		expect(session.attachments).toEqual([]);
		expect(session.state).toBe('draft');
		expect(
			(await (
				await call('GET', `/sandbox/api/sessions/${sessionId}`)
			).json()) as {
				session: { id: string };
			},
		).toMatchObject({ session: { id: sessionId } });
	});

	it('prepends the attachment note to the turn the driver receives', async () => {
		const root = await workspace();
		const sink = { prompt: '' };
		const runtime = fakeRuntime(root, capturingDriver(sink));
		const call = api(runtime);
		const session = await sessionFor(root);
		await call('POST', `/sandbox/api/sessions/${session.id}/attachments`, {
			body: {
				name: 'concept.md',
				contentBase64: Buffer.from('# concept\n').toString('base64'),
			},
		});

		const response = await call(
			'POST',
			`/sandbox/api/sessions/${session.id}/turn`,
			{
				body: {
					message: 'Build the screen like the concept.',
					role: 'business-manager',
					driver: 'fake',
				},
			},
		);
		const events = await readSse(response);
		expect(events.at(-1)?.event).toBe('ended');

		expect(sink.prompt).toContain('reference/attachments/');
		expect(sink.prompt).toContain('concept.md (file)');
		expect(sink.prompt).toContain('Build the screen like the concept.');

		const chat = await readChat(root, session);
		const userEntry = chat.find((entry) => entry.kind === 'user');
		expect(userEntry?.text).toBe('Build the screen like the concept.');
		expect(userEntry?.attachments?.map((item) => item.name)).toEqual([
			'concept.md',
		]);
	});
});
