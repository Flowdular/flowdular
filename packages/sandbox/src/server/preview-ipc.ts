import type { ChildProcess } from 'node:child_process';
import type { PreviewDatabaseReply } from './preview-database-protocol.ts';

/** connected can change between the check and the asynchronous pipe write. */
export function sendPreviewDatabaseReply(
	child: Pick<ChildProcess, 'connected' | 'send'>,
	reply: PreviewDatabaseReply,
): void {
	if (!child.connected) return;
	try {
		child.send(reply, () => undefined);
	} catch {
		// The worker closed the channel before Node could queue the write.
	}
}
