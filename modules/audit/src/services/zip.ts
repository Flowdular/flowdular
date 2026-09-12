import { crc32 } from 'node:zlib';

/**
 * A store-only ZIP writer built on node built-ins. The workspace carries no zip
 * dependency and an export must not add one, so this writes the format itself:
 * no compression, one entry per data class plus the manifest.
 *
 * Entries are streamed. The size and the checksum of an entry are not known
 * until its last row is written, so every local header sets the streaming flag
 * and the real values follow in a data descriptor; the central directory at the
 * end carries them again, which is where a reader takes them from.
 */
const LOCAL_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const STREAMING_FLAG = 0x0008;
const STORE = 0;
const VERSION = 20;
/* Unix regular file, owner read and write. A reader that restores modes gets
   the same owner-only file the archive itself is written with. */
const EXTERNAL_ATTRIBUTES = 0o100600 << 16;

/** No ZIP64: an entry or an archive at 4 GiB is a refusal, never a wrap. */
const SIZE_LIMIT = 0xffff_fffe;
/* One syscall per exported row would dominate the export; rows are gathered
   into a reused window first. */
const WRITE_WINDOW = 65_536;

/**
 * Where the archive bytes go. A file handle satisfies it directly; the export
 * passes a wrapper that digests every byte on the way out, so the archive is
 * fingerprinted without a second pass over the finished file.
 */
export interface ZipOutput {
	write(data: Buffer): Promise<unknown>;
}

interface ZipEntryRecord {
	readonly name: Buffer;
	readonly offset: number;
	readonly size: number;
	readonly checksum: number;
	readonly time: number;
	readonly date: number;
}

function dosTime(at: Date): { readonly time: number; readonly date: number } {
	/* MS-DOS stamps start in 1980 and keep two-second resolution. */
	const year = Math.max(1980, at.getFullYear());
	return {
		time:
			(at.getHours() << 11) |
			(at.getMinutes() << 5) |
			(Math.floor(at.getSeconds() / 2) & 0x1f),
		date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
	};
}

export class ZipWriteError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'ZipWriteError';
	}
}

export class StoredZipWriter {
	readonly #output: ZipOutput;
	readonly #at: Date;
	readonly #entries: ZipEntryRecord[] = [];
	#offset = 0;
	#pending: Buffer[] = [];
	#pendingBytes = 0;
	#open: {
		readonly name: Buffer;
		readonly offset: number;
		readonly time: number;
		readonly date: number;
		size: number;
		checksum: number;
	} | null = null;
	#closed = false;

	constructor(output: ZipOutput, at: Date = new Date()) {
		this.#output = output;
		this.#at = at;
	}

	async addEntry(name: string): Promise<void> {
		if (this.#open) {
			throw new ZipWriteError(
				'ZIP_ENTRY_OPEN',
				`The entry ${this.#open.name.toString('utf8')} is still open.`,
			);
		}
		const encoded = Buffer.from(name, 'utf8');
		if (encoded.byteLength === 0 || encoded.byteLength > 0xffff) {
			throw new ZipWriteError(
				'ZIP_ENTRY_NAME',
				`"${name}" is not an entry name.`,
			);
		}
		const stamp = dosTime(this.#at);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(LOCAL_HEADER, 0);
		header.writeUInt16LE(VERSION, 4);
		header.writeUInt16LE(STREAMING_FLAG, 6);
		header.writeUInt16LE(STORE, 8);
		header.writeUInt16LE(stamp.time, 10);
		header.writeUInt16LE(stamp.date, 12);
		header.writeUInt16LE(encoded.byteLength, 26);
		this.#open = {
			name: encoded,
			offset: this.#offset,
			time: stamp.time,
			date: stamp.date,
			size: 0,
			checksum: 0,
		};
		await this.#push(header);
		await this.#push(encoded);
	}

	async write(chunk: Buffer): Promise<void> {
		const open = this.#open;
		if (!open) {
			throw new ZipWriteError('ZIP_NO_ENTRY', 'No archive entry is open.');
		}
		if (open.size + chunk.byteLength > SIZE_LIMIT) {
			throw new ZipWriteError(
				'ZIP_ENTRY_TOO_LARGE',
				`${open.name.toString('utf8')} is larger than this archive format carries.`,
			);
		}
		open.checksum = crc32(chunk, open.checksum);
		open.size += chunk.byteLength;
		await this.#push(chunk);
	}

	async closeEntry(): Promise<void> {
		const open = this.#open;
		if (!open) return;
		const descriptor = Buffer.alloc(16);
		descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0);
		descriptor.writeUInt32LE(open.checksum >>> 0, 4);
		descriptor.writeUInt32LE(open.size, 8);
		descriptor.writeUInt32LE(open.size, 12);
		await this.#push(descriptor);
		this.#entries.push({
			name: open.name,
			offset: open.offset,
			size: open.size,
			checksum: open.checksum >>> 0,
			time: open.time,
			date: open.date,
		});
		this.#open = null;
	}

	/** Writes the central directory. The archive is unreadable without it. */
	async finish(): Promise<void> {
		if (this.#closed) return;
		await this.closeEntry();
		const start = this.#offset;
		for (const entry of this.#entries) {
			const header = Buffer.alloc(46);
			header.writeUInt32LE(CENTRAL_HEADER, 0);
			header.writeUInt16LE(VERSION, 4);
			header.writeUInt16LE(VERSION, 6);
			header.writeUInt16LE(STREAMING_FLAG, 8);
			header.writeUInt16LE(STORE, 10);
			header.writeUInt16LE(entry.time, 12);
			header.writeUInt16LE(entry.date, 14);
			header.writeUInt32LE(entry.checksum, 16);
			header.writeUInt32LE(entry.size, 20);
			header.writeUInt32LE(entry.size, 24);
			header.writeUInt16LE(entry.name.byteLength, 28);
			header.writeUInt32LE(EXTERNAL_ATTRIBUTES >>> 0, 38);
			header.writeUInt32LE(entry.offset, 42);
			await this.#push(header);
			await this.#push(entry.name);
		}
		const end = Buffer.alloc(22);
		end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
		end.writeUInt16LE(this.#entries.length, 8);
		end.writeUInt16LE(this.#entries.length, 10);
		end.writeUInt32LE(this.#offset - start, 12);
		end.writeUInt32LE(start, 16);
		await this.#push(end);
		await this.#flush();
		this.#closed = true;
	}

	async #push(chunk: Buffer): Promise<void> {
		this.#offset += chunk.byteLength;
		if (this.#offset > SIZE_LIMIT) {
			throw new ZipWriteError(
				'ZIP_ARCHIVE_TOO_LARGE',
				'The archive is larger than this archive format carries.',
			);
		}
		this.#pending.push(chunk);
		this.#pendingBytes += chunk.byteLength;
		if (this.#pendingBytes >= WRITE_WINDOW) await this.#flush();
	}

	async #flush(): Promise<void> {
		if (this.#pendingBytes === 0) return;
		const payload = Buffer.concat(this.#pending, this.#pendingBytes);
		this.#pending = [];
		this.#pendingBytes = 0;
		await this.#output.write(payload);
	}
}
