import { decodeCursor, encodeCursor } from '@flowdular/server';

/**
 * The keys a cursor is verified against. Every cursor issued is signed with
 * `current`; `previous` holds the keys a rotation has not finished retiring, so
 * a page already in a caller's hand still verifies. Cursors are never stored,
 * so a retired key can go once the outstanding pages are gone.
 */
export interface WorkflowCursorKeys {
	readonly current: Buffer;
	readonly previous: readonly Buffer[];
}

export type WorkflowCursorPayload = Record<string, string | number>;

export function signWorkflowCursor(
	payload: WorkflowCursorPayload,
	keys: WorkflowCursorKeys,
): string {
	return encodeCursor(payload, keys.current);
}

/** Throws the shared `CURSOR_INVALID` problem when no accepted key signed it. */
export function readWorkflowCursor(
	cursor: string,
	keys: WorkflowCursorKeys,
): WorkflowCursorPayload {
	let refusal: unknown;
	for (const key of [keys.current, ...keys.previous]) {
		try {
			return decodeCursor(cursor, key);
		} catch (error) {
			refusal = error;
		}
	}
	throw refusal;
}
