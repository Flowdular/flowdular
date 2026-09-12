import { createHash, createHmac } from 'node:crypto';

/* AWS Signature Version 4 for the four S3 operations the port performs. The
   whole surface is PutObject, GetObject (whole and ranged) and DeleteObject, so
   the signer is a hundred lines of node:crypto rather than an SDK and its
   transitive tree in every generated application. */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

export interface SigV4Credentials {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly region: string;
}

export function sha256Hex(value: Uint8Array | string): string {
	return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Uint8Array | string, value: string): Buffer {
	return createHmac('sha256', key).update(value, 'utf8').digest();
}

/**
 * RFC 3986 encoding per path segment, with `/` kept as the separator. S3 signs
 * the object key exactly as it appears in the request line, so the same
 * function produces the path and the canonical URI.
 */
export function encodeS3Path(path: string): string {
	return path
		.split('/')
		.map((segment) =>
			encodeURIComponent(segment).replace(
				/[!'()*]/g,
				(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
			),
		)
		.join('/');
}

/** `YYYYMMDDTHHMMSSZ`, the only timestamp spelling SigV4 accepts. */
export function amazonDate(now: Date): string {
	return `${now.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/**
 * The request headers plus `x-amz-date`, `x-amz-content-sha256` and
 * `authorization`. `canonicalUri` is the already-encoded path, so nothing is
 * encoded twice.
 */
export function signS3Request(input: {
	readonly method: string;
	readonly canonicalUri: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly payloadHash: string;
	readonly credentials: SigV4Credentials;
	readonly now: Date;
}): Record<string, string> {
	const timestamp = amazonDate(input.now);
	const date = timestamp.slice(0, 8);
	const headers: Record<string, string> = {
		...input.headers,
		'x-amz-content-sha256': input.payloadHash,
		'x-amz-date': timestamp,
	};
	const canonical = new Map<string, string>();
	for (const [name, value] of Object.entries(headers)) {
		canonical.set(name.toLowerCase(), value.trim().replace(/\s+/g, ' '));
	}
	const names = [...canonical.keys()].sort();
	const canonicalHeaders = names
		.map((name) => `${name}:${canonical.get(name) ?? ''}\n`)
		.join('');
	const signedHeaders = names.join(';');
	const canonicalRequest = [
		input.method,
		input.canonicalUri,
		'',
		canonicalHeaders,
		signedHeaders,
		input.payloadHash,
	].join('\n');
	const scope = `${date}/${input.credentials.region}/${SERVICE}/aws4_request`;
	const stringToSign = [
		ALGORITHM,
		timestamp,
		scope,
		sha256Hex(canonicalRequest),
	].join('\n');
	const signingKey = hmac(
		hmac(
			hmac(
				hmac(`AWS4${input.credentials.secretAccessKey}`, date),
				input.credentials.region,
			),
			SERVICE,
		),
		'aws4_request',
	);
	const signature = hmac(signingKey, stringToSign).toString('hex');
	headers.authorization = `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
	return headers;
}
