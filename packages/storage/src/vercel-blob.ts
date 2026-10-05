import {
	BlobError,
	BlobNotFoundError,
	del,
	get,
	head,
	put,
} from '@vercel/blob';
import { StorageError } from './contracts.ts';
import type { ObjectStore } from './store.ts';

const REQUEST_TIMEOUT_MS = 30_000;
/* Blob takes at most 950 characters and refuses an empty segment. A segment
   that starts with a dot or carries a URL delimiter would be rewritten by the
   URL the SDK builds from the pathname, so it is refused here as well. */
const PATHNAME_LIMIT = 950;
const PATHNAME_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const ERROR_NAME_PATTERN = /^[A-Za-z]{1,64}$/;

export interface VercelBlobObjectStoreOptions {
	/** Selects OIDC: on Vercel the SDK reads and refreshes the token itself. */
	readonly storeId?: string | undefined;
	/** A read-write token, for a deployment outside Vercel. */
	readonly token?: string | undefined;
	/** The largest frame a full read accepts. */
	readonly maxFrameBytes: number;
}

function pathnameOf(key: string): string {
	if (key.length > PATHNAME_LIMIT || !PATHNAME_PATTERN.test(key)) {
		throw new StorageError(
			'OBJECT_REFERENCE_INVALID',
			`A Vercel Blob pathname must be at most ${PATHNAME_LIMIT} characters of "/"-separated segments of letters, digits, ".", "_" and "-", each starting with a letter or digit.`,
		);
	}
	return key;
}

/* Only the error class reaches the message. The SDK's text repeats what the
   service answered, and a provider must not be able to write exception text,
   as in the S3 adapter. */
function unavailable(action: string, error: unknown): StorageError {
	const name =
		error instanceof BlobError
			? error.constructor.name
			: error instanceof Error
				? error.name
				: '';
	return new StorageError(
		'STORAGE_UNAVAILABLE',
		`The object store refused to ${action}: ${ERROR_NAME_PATTERN.test(name) ? name : 'unknown error'}.`,
	);
}

/* The SDK retries a failed put, head or del after backoff sleeps the signal
   does not interrupt, so an abort alone ends a call only at its next attempt.
   The deadline therefore settles the call itself, and the race keeps the
   abandoned call's late outcome handled and dropped. It still aborts, with
   the default AbortError reason, since the SDK gives up on an AbortError but
   retries the TimeoutError of AbortSignal.timeout. */
async function withDeadline<T>(
	action: string,
	run: (abortSignal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(
				new StorageError(
					'STORAGE_UNAVAILABLE',
					`The object store did not ${action} within ${REQUEST_TIMEOUT_MS / 1000} s.`,
				),
			);
			controller.abort();
		}, REQUEST_TIMEOUT_MS);
	});
	try {
		return await Promise.race([run(controller.signal), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Frames in a private Vercel Blob store, addressed by their key. Reads skip
 * the CDN cache, so a re-sealed or deleted frame is never answered from a copy
 * that predates the change.
 */
export function createVercelBlobObjectStore(
	options: VercelBlobObjectStoreOptions,
): ObjectStore {
	/* An explicit token outranks OIDC inside the SDK, so it is passed only when
	   no store id selects OIDC. */
	const credentials = options.storeId
		? { storeId: options.storeId }
		: options.token
			? { token: options.token }
			: {};

	return {
		async write(key, frame) {
			const pathname = pathnameOf(key);
			await withDeadline(`store ${key}`, async (abortSignal) => {
				try {
					await put(
						pathname,
						Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength),
						{
							access: 'private',
							addRandomSuffix: false,
							/* A re-seal under a rotated key rewrites the frame in place. */
							allowOverwrite: true,
							contentType: 'application/octet-stream',
							abortSignal,
							...credentials,
						},
					);
				} catch (error) {
					throw unavailable(`store ${key}`, error);
				}
			});
		},
		async read(key, maxBytes) {
			const pathname = pathnameOf(key);
			return withDeadline(`read ${key}`, async (abortSignal) => {
				let result;
				try {
					result = await get(pathname, {
						access: 'private',
						useCache: false,
						abortSignal,
						/* The loop below still cancels at the prefix, for a server that
						   answers a range request with the whole object. */
						...(maxBytes === undefined
							? {}
							: { headers: { range: `bytes=0-${maxBytes - 1}` } }),
						...credentials,
					});
				} catch (error) {
					throw unavailable(`read ${key}`, error);
				}
				if (!result) return null;
				if (!result.stream) throw unavailable(`read ${key}`, undefined);
				const limit = maxBytes ?? options.maxFrameBytes;
				const reader = result.stream.getReader();
				const chunks: Uint8Array[] = [];
				let total = 0;
				try {
					for (;;) {
						if (maxBytes !== undefined && total >= maxBytes) {
							await reader.cancel();
							break;
						}
						const { value, done } = await reader.read();
						if (done) break;
						total += value.byteLength;
						if (maxBytes === undefined && total > limit) {
							await reader.cancel();
							throw new StorageError(
								'OBJECT_TOO_LARGE',
								`The stored frame ${key} exceeds ${limit} bytes.`,
							);
						}
						chunks.push(value);
					}
				} catch (error) {
					if (error instanceof StorageError) throw error;
					throw unavailable(`read ${key}`, error);
				} finally {
					reader.releaseLock();
				}
				return Buffer.concat(chunks, Math.min(total, limit));
			});
		},
		async remove(key) {
			const pathname = pathnameOf(key);
			return withDeadline(`delete ${key}`, async (abortSignal) => {
				/* A Blob delete succeeds for an absent pathname, so the caller is
				   told whether the object was there by looking first. */
				try {
					await head(pathname, { abortSignal, ...credentials });
				} catch (error) {
					if (error instanceof BlobNotFoundError) return false;
					throw unavailable(`read ${key}`, error);
				}
				try {
					await del(pathname, { abortSignal, ...credentials });
				} catch (error) {
					throw unavailable(`delete ${key}`, error);
				}
				return true;
			});
		},
		close: () => Promise.resolve(),
	};
}
