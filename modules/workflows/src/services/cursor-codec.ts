import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WorkflowCursorCodec {
	encode(kind: 'wfrc1' | 'wfac1' | 'wfre1', payload: object): string;
	decode<T extends object>(
		kind: 'wfrc1' | 'wfac1' | 'wfre1',
		cursor: string,
	): T;
}

/**
 * `previous` holds the cursor keys a rotation has not finished retiring: a
 * cursor already in a caller's hand still verifies, while every cursor this
 * codec issues is signed with `secret`. Cursors are never stored, so a cursor
 * key needs no re-signing pass; the previous keys can go once the outstanding
 * pages are gone.
 */
export function createWorkflowCursorCodec(
	secret: Buffer,
	previous: readonly Buffer[] = [],
): WorkflowCursorCodec {
	if (secret.length < 32)
		throw new Error('Workflow cursor signing requires 32 bytes.');
	for (const key of previous) {
		if (key.length < 32)
			throw new Error('Workflow cursor signing requires 32 bytes.');
	}
	const accepted = [secret, ...previous];
	return {
		encode(kind, payload) {
			const body = Buffer.from(JSON.stringify({ kind, ...payload })).toString(
				'base64url',
			);
			const signature = createHmac('sha256', secret)
				.update(body)
				.digest('base64url');
			return `${kind}.${body}.${signature}`;
		},
		decode<T extends object>(
			kind: 'wfrc1' | 'wfac1' | 'wfre1',
			cursor: string,
		): T {
			if (cursor.length > 2048) throw new Error('WORKFLOW_CURSOR_INVALID');
			const [prefix, body, signature, extra] = cursor.split('.');
			if (prefix !== kind || !body || !signature || extra !== undefined) {
				throw new Error('WORKFLOW_CURSOR_INVALID');
			}
			let supplied: Buffer;
			try {
				supplied = Buffer.from(signature, 'base64url');
			} catch {
				throw new Error('WORKFLOW_CURSOR_INVALID');
			}
			const signed = accepted.some((key) => {
				const expected = createHmac('sha256', key).update(body).digest();
				return (
					expected.length === supplied.length &&
					timingSafeEqual(expected, supplied)
				);
			});
			if (!signed) throw new Error('WORKFLOW_CURSOR_INVALID');
			let value: unknown;
			try {
				value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
			} catch {
				throw new Error('WORKFLOW_CURSOR_INVALID');
			}
			if (
				value === null ||
				typeof value !== 'object' ||
				(value as { kind?: unknown }).kind !== kind
			) {
				throw new Error('WORKFLOW_CURSOR_INVALID');
			}
			return value as T;
		},
	};
}
