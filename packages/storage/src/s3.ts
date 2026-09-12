import { StorageError } from './contracts.ts';
import {
	encodeS3Path,
	sha256Hex,
	signS3Request,
	type SigV4Credentials,
} from './sigv4.ts';
import type { ObjectStore } from './store.ts';

const REQUEST_TIMEOUT_MS = 30_000;
/* An S3 error body is XML naming a code and the resource. Only the code reaches
   the message, bounded, so a provider cannot grow an exception text at will. */
const ERROR_CODE_LIMIT = 64;

export interface S3ObjectStoreOptions {
	readonly bucket: string;
	readonly region: string;
	/** Absent uses the AWS endpoint for the region; MinIO and R2 set their own. */
	readonly endpoint?: string | undefined;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	/** MinIO and most self-hosted gateways need `<endpoint>/<bucket>/<key>`. */
	readonly forcePathStyle: boolean;
	readonly fetch?: typeof globalThis.fetch | undefined;
	readonly clock?: (() => Date) | undefined;
}

function errorCode(body: string): string {
	return (
		/<Code>([^<]{1,64})<\/Code>/.exec(body)?.[1]?.slice(0, ERROR_CODE_LIMIT) ??
		'unknown'
	);
}

async function unavailable(
	action: string,
	response: Response,
): Promise<StorageError> {
	const body = await response.text().catch(() => '');
	return new StorageError(
		'STORAGE_UNAVAILABLE',
		`The object store refused to ${action}: HTTP ${response.status} ${errorCode(body)}.`,
	);
}

export function createS3ObjectStore(
	options: S3ObjectStoreOptions,
): ObjectStore {
	const credentials: SigV4Credentials = {
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey,
		region: options.region,
	};
	const call = options.fetch ?? globalThis.fetch;
	const clock = options.clock ?? (() => new Date());
	const endpoint = new URL(
		options.endpoint?.trim() || `https://s3.${options.region}.amazonaws.com`,
	);
	const origin = options.forcePathStyle
		? `${endpoint.protocol}//${endpoint.host}`
		: `${endpoint.protocol}//${options.bucket}.${endpoint.host}`;
	const host = new URL(origin).host;
	const basePath = options.forcePathStyle ? `/${options.bucket}` : '';

	async function request(
		method: string,
		key: string,
		init: {
			readonly body?: Uint8Array | undefined;
			readonly headers?: Readonly<Record<string, string>> | undefined;
		} = {},
	): Promise<Response> {
		const canonicalUri = encodeS3Path(`${basePath}/${key}`);
		const signed = signS3Request({
			method,
			canonicalUri,
			headers: { host, ...init.headers },
			payloadHash: sha256Hex(init.body ?? ''),
			credentials,
			now: clock(),
		});
		/* fetch owns Host and sets it from the URL, so sending the signed copy is
		   both refused and unnecessary: the value the server reads is the one the
		   signature covers. Content-Length is forbidden for the same reason, which
		   is why it is neither sent nor signed. */
		const { host: _signedHost, ...sendable } = signed;
		try {
			return await call(`${origin}${canonicalUri}`, {
				method,
				headers: sendable,
				/* fetch accepts a typed array body at run time; BodyInit only spells
				   the ArrayBuffer-backed view, and copying the frame to satisfy the
				   type would double what one request holds. */
				...(init.body ? { body: init.body as unknown as BodyInit } : {}),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			throw new StorageError(
				'STORAGE_UNAVAILABLE',
				`The object store did not answer a ${method} request.`,
				{ cause: error },
			);
		}
	}

	return {
		async write(key, frame) {
			const response = await request('PUT', key, {
				body: frame,
				headers: { 'content-type': 'application/octet-stream' },
			});
			if (!response.ok) throw await unavailable(`store ${key}`, response);
			await response.body?.cancel();
		},
		async read(key, maxBytes) {
			const response = await request('GET', key, {
				...(maxBytes === undefined
					? {}
					: { headers: { range: `bytes=0-${maxBytes - 1}` } }),
			});
			if (response.status === 404) {
				await response.body?.cancel();
				return null;
			}
			if (!response.ok) throw await unavailable(`read ${key}`, response);
			return new Uint8Array(await response.arrayBuffer());
		},
		async remove(key) {
			/* S3 deletes are idempotent and answer 204 for an absent key, so the
			   caller is told whether the object was there by looking first. */
			const head = await request('HEAD', key);
			await head.body?.cancel();
			if (head.status === 404) return false;
			if (!head.ok) throw await unavailable(`read ${key}`, head);
			const response = await request('DELETE', key);
			if (!response.ok && response.status !== 404) {
				throw await unavailable(`delete ${key}`, response);
			}
			await response.body?.cancel();
			return true;
		},
		close: () => Promise.resolve(),
	};
}
