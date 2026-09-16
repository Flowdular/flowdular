import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

export class ZipUnreadable extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ZipUnreadable';
	}
}

interface ZipEntry {
	readonly name: string;
	readonly method: number;
	readonly encrypted: boolean;
	readonly compressedSize: number;
	readonly localOffset: number;
}

export interface ZipLimits {
	readonly entries: number;
	readonly inflatedBytes: number;
}

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const END_RECORD = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_MARKER = 0xffffffff;
const STORED = 0;
const DEFLATE = 8;
const CHUNK = 64 * 1024;

/**
 * An OOXML package read through its central directory. Only stored and deflate
 * entries without encryption and without ZIP64 are read. The inflation budget
 * is shared by every part of one package and spent on the bytes the inflater
 * actually produces, never on the sizes the archive claims, so an entry that
 * lies about its size stops at the same bound as one that does not.
 */
export class ZipPackage {
	readonly #bytes: Buffer;
	readonly #entries = new Map<string, ZipEntry>();
	readonly #centralOffset: number;
	#remaining: number;
	#exhausted = false;

	constructor(bytes: Uint8Array, limits: ZipLimits) {
		this.#bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.#remaining = limits.inflatedBytes;
		const end = this.#endRecord();
		const view = this.#bytes;
		const disk = view.readUInt16LE(end + 4);
		const centralDisk = view.readUInt16LE(end + 6);
		const count = view.readUInt16LE(end + 10);
		const size = view.readUInt32LE(end + 12);
		const offset = view.readUInt32LE(end + 16);
		if (disk !== 0 || centralDisk !== 0) {
			throw new ZipUnreadable('A multi-disk archive is not read.');
		}
		if (count === 0xffff || size === ZIP64_MARKER || offset === ZIP64_MARKER) {
			throw new ZipUnreadable('A ZIP64 archive is not read.');
		}
		if (count > limits.entries) {
			throw new ZipUnreadable('The archive lists too many entries.');
		}
		if (offset + size > end) {
			throw new ZipUnreadable('The central directory lies outside the file.');
		}
		this.#centralOffset = offset;
		let cursor = offset;
		for (let index = 0; index < count; index += 1) {
			if (cursor + 46 > offset + size) {
				throw new ZipUnreadable('The central directory is cut short.');
			}
			if (view.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
				throw new ZipUnreadable('A central directory entry is malformed.');
			}
			const flags = view.readUInt16LE(cursor + 8);
			const method = view.readUInt16LE(cursor + 10);
			const compressedSize = view.readUInt32LE(cursor + 20);
			const uncompressedSize = view.readUInt32LE(cursor + 24);
			const nameLength = view.readUInt16LE(cursor + 28);
			const extraLength = view.readUInt16LE(cursor + 30);
			const commentLength = view.readUInt16LE(cursor + 32);
			const localOffset = view.readUInt32LE(cursor + 42);
			const next = cursor + 46 + nameLength + extraLength + commentLength;
			if (next > offset + size) {
				throw new ZipUnreadable('A central directory entry is cut short.');
			}
			if (
				compressedSize === ZIP64_MARKER ||
				uncompressedSize === ZIP64_MARKER ||
				localOffset === ZIP64_MARKER
			) {
				throw new ZipUnreadable('A ZIP64 entry is not read.');
			}
			const name = view.toString(
				(flags & 0x0800) === 0 ? 'latin1' : 'utf8',
				cursor + 46,
				cursor + 46 + nameLength,
			);
			/* Two entries under one name leave the part a reader sees up to the
			   order it looks them up in, which is exactly what a crafted package
			   would exploit. */
			if (this.#entries.has(name)) {
				throw new ZipUnreadable('The archive names one part twice.');
			}
			this.#entries.set(name, {
				name,
				method,
				encrypted: (flags & 0x0001) !== 0,
				compressedSize,
				localOffset,
			});
			cursor = next;
		}
	}

	/** True once a part stopped at the inflation budget. */
	get exhausted(): boolean {
		return this.#exhausted;
	}

	has(name: string): boolean {
		return this.#entries.has(name);
	}

	/**
	 * The inflated bytes of one part, chunk by chunk. A consumer that stops
	 * iterating stops the inflater; a part that reaches the budget yields what
	 * fits and ends, with `exhausted` set.
	 */
	async *read(name: string): AsyncGenerator<Buffer> {
		const entry = this.#entries.get(name);
		if (!entry) throw new ZipUnreadable(`The part ${name} is missing.`);
		if (entry.encrypted) {
			throw new ZipUnreadable('An encrypted entry is not read.');
		}
		const data = this.#data(entry);
		if (entry.method === STORED) {
			for (let start = 0; start < data.byteLength; start += CHUNK) {
				const chunk = this.#spend(data.subarray(start, start + CHUNK));
				if (chunk.byteLength > 0) yield chunk;
				if (this.#exhausted) return;
			}
			return;
		}
		if (entry.method !== DEFLATE) {
			throw new ZipUnreadable('Only stored and deflate entries are read.');
		}
		const inflater = Readable.from([data], { objectMode: false }).pipe(
			createInflateRaw({ chunkSize: CHUNK }),
		);
		try {
			for await (const produced of inflater) {
				const chunk = this.#spend(produced as Buffer);
				if (chunk.byteLength > 0) yield chunk;
				if (this.#exhausted) return;
			}
		} catch (error) {
			if (error instanceof ZipUnreadable) throw error;
			throw new ZipUnreadable('A part does not inflate.');
		} finally {
			inflater.destroy();
		}
	}

	#spend(chunk: Buffer): Buffer {
		if (chunk.byteLength <= this.#remaining) {
			this.#remaining -= chunk.byteLength;
			return chunk;
		}
		const allowed = chunk.subarray(0, this.#remaining);
		this.#remaining = 0;
		this.#exhausted = true;
		return allowed;
	}

	#data(entry: ZipEntry): Buffer {
		const view = this.#bytes;
		const at = entry.localOffset;
		if (
			at + 30 > this.#centralOffset ||
			view.readUInt32LE(at) !== LOCAL_SIGNATURE
		) {
			throw new ZipUnreadable('A local entry header is malformed.');
		}
		const start =
			at + 30 + view.readUInt16LE(at + 26) + view.readUInt16LE(at + 28);
		const end = start + entry.compressedSize;
		if (end > this.#centralOffset) {
			throw new ZipUnreadable('An entry lies outside the file.');
		}
		return view.subarray(start, end);
	}

	#endRecord(): number {
		const view = this.#bytes;
		const last = view.byteLength - END_RECORD;
		const first = Math.max(0, last - MAX_COMMENT);
		for (let at = last; at >= first; at -= 1) {
			if (view.readUInt32LE(at) === END_SIGNATURE) return at;
		}
		throw new ZipUnreadable('The file is not a ZIP archive.');
	}
}
