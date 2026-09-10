import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { sendPreviewDatabaseReply } from '../src/server/preview-ipc.ts';
import { PREVIEW_DATABASE_REPLY } from '../src/server/preview-database-protocol.ts';

describe('preview IPC teardown', () => {
	it('observes pipe errors delivered after the connected check', async () => {
		const emitter = new EventEmitter();
		const unhandled: Error[] = [];
		emitter.on('error', (error: Error) => unhandled.push(error));
		const child = Object.assign(emitter, {
			connected: true,
			send(_message: unknown, callback?: (error: Error) => void) {
				queueMicrotask(() => {
					const error = Object.assign(new Error('write EPIPE'), {
						code: 'EPIPE',
					});
					// Node emits error only when no send callback owns the failure.
					if (callback) callback(error);
					else emitter.emit('error', error);
				});
				return false;
			},
		});
		sendPreviewDatabaseReply(child as unknown as ChildProcess, {
			type: PREVIEW_DATABASE_REPLY,
			id: 1,
			ok: true,
			value: null,
		});
		await Promise.resolve();
		expect(unhandled).toEqual([]);
	});

	it('tolerates a synchronous channel close and skips disconnected workers', () => {
		let calls = 0;
		const child = {
			connected: true,
			send() {
				calls += 1;
				throw new Error('IPC channel closed');
			},
		};
		expect(() =>
			sendPreviewDatabaseReply(child as unknown as ChildProcess, {
				type: PREVIEW_DATABASE_REPLY,
				id: 1,
				ok: true,
				value: null,
			}),
		).not.toThrow();
		child.connected = false;
		sendPreviewDatabaseReply(child as unknown as ChildProcess, {
			type: PREVIEW_DATABASE_REPLY,
			id: 2,
			ok: true,
			value: null,
		});
		expect(calls).toBe(1);
	});
});
