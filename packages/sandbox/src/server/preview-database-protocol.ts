import {
	DatabaseError,
	type DatabaseCapabilities,
	type DatabaseErrorCode,
	type DatabaseIsolationLevel,
	type DatabaseProviderRequest,
	type DatabaseRequirements,
	type DatabaseStatement,
} from '@flowdular/database';

/* The preview worker runs under Node's permission model, which denies
   process.binding unconditionally, and the embedded PostgreSQL build needs it.
   So the engine stays in the sandbox process and the worker drives it over the
   IPC channel it already owns. Only structured-clone values cross that channel:
   no AbortSignal, no capability functions, no Error instances. */

export const PREVIEW_DATABASE_REQUEST = 'flowdular.preview-database.request';
export const PREVIEW_DATABASE_REPLY = 'flowdular.preview-database.reply';

/** Static lease metadata, sent once when the lease is granted. */
export interface PreviewDatabaseGrant {
	readonly adapterId: string;
	readonly dialectId: string;
	/** The dialect-owned `sql` functions are rebuilt from `dialectId`. */
	readonly capabilities: Omit<DatabaseCapabilities, 'sql'>;
}

export interface PreviewDatabaseLeaseRequest {
	readonly namespace: string;
	readonly purpose: DatabaseProviderRequest['purpose'];
	readonly requirements?: DatabaseRequirements;
	readonly timeoutMs?: number;
}

export interface PreviewDatabaseTransactionOptions {
	readonly access?: 'read' | 'write';
	readonly isolation?: DatabaseIsolationLevel;
	readonly tenantId?: string;
	readonly timeoutMs?: number;
}

/** Names the parent-side connection an operation runs on. */
export interface PreviewDatabaseTarget {
	readonly lease: number;
	/** Set for a statement issued inside a transaction callback. */
	readonly transaction?: number;
}

interface PreviewDatabaseOperation {
	readonly target: PreviewDatabaseTarget;
	readonly timeoutMs?: number;
}

export type PreviewDatabaseCall =
	| {
			readonly kind: 'acquire';
			readonly lease: number;
			readonly request: PreviewDatabaseLeaseRequest;
	  }
	| { readonly kind: 'release'; readonly lease: number }
	| {
			readonly kind: 'begin';
			readonly lease: number;
			readonly transaction: number;
			readonly options: PreviewDatabaseTransactionOptions;
	  }
	| {
			readonly kind: 'settle';
			readonly transaction: number;
			/** Null commits. Anything else rolls back with that failure. */
			readonly error: PreviewDatabaseFailure | null;
	  }
	| {
			readonly kind: 'migration-lock';
			readonly transaction: number;
			readonly namespace: string;
	  }
	| (PreviewDatabaseOperation & {
			readonly kind: 'query' | 'execute';
			readonly statement: DatabaseStatement;
	  })
	| (PreviewDatabaseOperation & {
			readonly kind: 'script';
			readonly script: string;
	  })
	| (PreviewDatabaseOperation & {
			readonly kind: 'has-table' | 'has-index';
			readonly name: string;
	  })
	| (PreviewDatabaseOperation & {
			readonly kind: 'has-column';
			readonly table: string;
			readonly column: string;
	  });

export interface PreviewDatabaseRequest {
	readonly type: typeof PREVIEW_DATABASE_REQUEST;
	readonly id: number;
	readonly call: PreviewDatabaseCall;
}

export interface PreviewDatabaseFailure {
	readonly name: string;
	readonly message: string;
	readonly code?: string;
	readonly stack?: string;
}

export type PreviewDatabaseReply = {
	readonly type: typeof PREVIEW_DATABASE_REPLY;
	readonly id: number;
} & (
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly error: PreviewDatabaseFailure }
);

export function isPreviewDatabaseRequest(
	message: unknown,
): message is PreviewDatabaseRequest {
	return (
		typeof message === 'object' &&
		message !== null &&
		(message as PreviewDatabaseRequest).type === PREVIEW_DATABASE_REQUEST
	);
}

export function isPreviewDatabaseReply(
	message: unknown,
): message is PreviewDatabaseReply {
	return (
		typeof message === 'object' &&
		message !== null &&
		(message as PreviewDatabaseReply).type === PREVIEW_DATABASE_REPLY
	);
}

/* Module code and the platform suites branch on DatabaseError.code and on the
   driver's own SQLSTATE, and neither survives structured cloning of an Error.
   Both travel as data and are put back together on the far side. */
export function previewDatabaseFailure(error: unknown): PreviewDatabaseFailure {
	if (!(error instanceof Error)) {
		return { name: 'Error', message: String(error) };
	}
	const code = (error as { readonly code?: unknown }).code;
	return {
		name: error.name,
		message: error.message,
		...(typeof code === 'string' ? { code } : {}),
		...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
	};
}

export function previewDatabaseError(failure: PreviewDatabaseFailure): Error {
	const error =
		failure.name === 'DatabaseError' && failure.code !== undefined
			? new DatabaseError(failure.code as DatabaseErrorCode, failure.message)
			: Object.assign(new Error(failure.message), {
					name: failure.name,
					...(failure.code === undefined ? {} : { code: failure.code }),
				});
	if (failure.stack !== undefined) error.stack = failure.stack;
	return error;
}
