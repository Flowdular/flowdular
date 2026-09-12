import { createHash } from 'node:crypto';
import type { Keyring } from '@flowdular/kernel';
import {
	StorageError,
	type StorageScanVerdict,
	type StoredObject,
} from './contracts.ts';

/* One frame per object, so an adapter moves bytes and nothing else:

     "FDS1" | uint32BE header length | header JSON | ciphertext

   The header is cleartext because `stat` must read metadata without holding the
   key, and it is authenticated all the same: every field goes into the GCM
   additional data, so a header edited in the object store fails to open. The
   canonical key is in that data too, which binds the ciphertext to its tenant
   and makes an object copied to another tenant's prefix unreadable. */

const MAGIC = 'FDS1';
const HEADER_LENGTH_BYTES = 4;
const HEADER_LIMIT = 4096;

/** Bytes `stat` reads: enough for the magic, the length and the largest header. */
export const STORAGE_HEADER_PREFIX_BYTES =
	MAGIC.length + HEADER_LENGTH_BYTES + HEADER_LIMIT;

interface FrameHeader {
	readonly v: 1;
	readonly keyId: string;
	readonly iv: string;
	readonly tag: string;
	readonly contentType: string;
	readonly bytes: number;
	readonly checksum: string;
	readonly scan: StorageScanVerdict;
	readonly createdAt: string;
}

export function storageChecksum(plaintext: Uint8Array): string {
	return `sha256:${createHash('sha256').update(plaintext).digest('hex')}`;
}

function additionalData(key: string, header: FrameHeader): string {
	return [
		key,
		header.contentType,
		String(header.bytes),
		header.checksum,
		header.scan,
		header.createdAt,
	].join('\n');
}

function corrupt(detail: string): StorageError {
	return new StorageError(
		'OBJECT_CORRUPT',
		`The stored object could not be read: ${detail}.`,
	);
}

function parseHeader(frame: Uint8Array): {
	readonly header: FrameHeader;
	readonly ciphertextOffset: number;
} {
	const prefix = MAGIC.length + HEADER_LENGTH_BYTES;
	if (frame.byteLength < prefix) throw corrupt('the frame is truncated');
	if (Buffer.from(frame.subarray(0, MAGIC.length)).toString() !== MAGIC) {
		throw corrupt('the frame carries no Flowdular object header');
	}
	const length = new DataView(
		frame.buffer,
		frame.byteOffset,
		frame.byteLength,
	).getUint32(MAGIC.length, false);
	if (length === 0 || length > HEADER_LIMIT) {
		throw corrupt('the header length is out of range');
	}
	if (frame.byteLength < prefix + length) {
		throw corrupt('the header is truncated');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			Buffer.from(frame.subarray(prefix, prefix + length)).toString('utf8'),
		);
	} catch (error) {
		throw new StorageError(
			'OBJECT_CORRUPT',
			'The stored object header is not JSON.',
			{ cause: error },
		);
	}
	const header = parsed as Partial<FrameHeader>;
	if (
		header.v !== 1 ||
		typeof header.keyId !== 'string' ||
		typeof header.iv !== 'string' ||
		typeof header.tag !== 'string' ||
		typeof header.contentType !== 'string' ||
		typeof header.bytes !== 'number' ||
		typeof header.checksum !== 'string' ||
		typeof header.createdAt !== 'string' ||
		(header.scan !== 'clean' &&
			header.scan !== 'infected' &&
			header.scan !== 'unscanned')
	) {
		throw corrupt('the header does not describe a version 1 object');
	}
	return { header: header as FrameHeader, ciphertextOffset: prefix + length };
}

function describe(key: string, header: FrameHeader): StoredObject {
	return {
		key,
		bytes: header.bytes,
		contentType: header.contentType,
		checksum: header.checksum,
		keyId: header.keyId,
		scan: header.scan,
		createdAt: new Date(header.createdAt),
	};
}

export function encodeStoredObject(
	keyring: Keyring,
	key: string,
	plaintext: Uint8Array,
	metadata: {
		readonly contentType: string;
		readonly scan: StorageScanVerdict;
		readonly createdAt: Date;
	},
): { readonly frame: Uint8Array; readonly object: StoredObject } {
	const draft = {
		v: 1,
		keyId: keyring.keyId,
		iv: '',
		tag: '',
		contentType: metadata.contentType,
		bytes: plaintext.byteLength,
		checksum: storageChecksum(plaintext),
		scan: metadata.scan,
		createdAt: metadata.createdAt.toISOString(),
	} satisfies FrameHeader;
	const sealed = keyring.seal(plaintext, additionalData(key, draft));
	const header: FrameHeader = {
		...draft,
		keyId: sealed.keyId,
		iv: sealed.iv.toString('base64'),
		tag: sealed.tag.toString('base64'),
	};
	const encoded = Buffer.from(JSON.stringify(header), 'utf8');
	if (encoded.byteLength > HEADER_LIMIT) {
		throw corrupt('the header exceeds its size limit');
	}
	const prefix = Buffer.alloc(MAGIC.length + HEADER_LENGTH_BYTES);
	prefix.write(MAGIC, 0, 'latin1');
	prefix.writeUInt32BE(encoded.byteLength, MAGIC.length);
	return {
		frame: Buffer.concat([prefix, encoded, sealed.ciphertext]),
		object: describe(key, header),
	};
}

/** Metadata only. The bytes are authenticated by `openStoredObject`, not here. */
export function readStoredObjectHeader(
	key: string,
	frame: Uint8Array,
): StoredObject {
	return describe(key, parseHeader(frame).header);
}

export function openStoredObject(
	keyring: Keyring,
	key: string,
	frame: Uint8Array,
): { readonly object: StoredObject; readonly plaintext: Buffer } {
	const { header, ciphertextOffset } = parseHeader(frame);
	const plaintext = keyring.open(
		{
			keyId: header.keyId,
			iv: Buffer.from(header.iv, 'base64'),
			tag: Buffer.from(header.tag, 'base64'),
			ciphertext: frame.subarray(ciphertextOffset),
		},
		additionalData(key, header),
	);
	return { object: describe(key, header), plaintext };
}
