import { crc32 } from 'node:zlib';

/**
 * A store-only ZIP reader written for these tests alone. It reads the central
 * directory rather than the local headers, which is what proves the archive is
 * readable the way any ZIP tool reads one: entry names, sizes and checksums all
 * come from the directory, and each entry's bytes are taken from the offset it
 * records.
 */
const CENTRAL_HEADER = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

export interface ZipEntry {
	readonly name: string;
	readonly data: Buffer;
}

export function readStoredZip(archive: Buffer): readonly ZipEntry[] {
	let end = archive.byteLength - 22;
	while (end >= 0 && archive.readUInt32LE(end) !== END_OF_CENTRAL_DIRECTORY) {
		end -= 1;
	}
	if (end < 0) throw new Error('The archive has no end of central directory.');
	const count = archive.readUInt16LE(end + 10);
	let cursor = archive.readUInt32LE(end + 16);
	const entries: ZipEntry[] = [];
	for (let index = 0; index < count; index += 1) {
		if (archive.readUInt32LE(cursor) !== CENTRAL_HEADER) {
			throw new Error(`Central directory entry ${index} is malformed.`);
		}
		const method = archive.readUInt16LE(cursor + 10);
		if (method !== 0) throw new Error('Only stored entries are supported.');
		const checksum = archive.readUInt32LE(cursor + 16);
		const size = archive.readUInt32LE(cursor + 24);
		const nameLength = archive.readUInt16LE(cursor + 28);
		const extraLength = archive.readUInt16LE(cursor + 30);
		const commentLength = archive.readUInt16LE(cursor + 32);
		const offset = archive.readUInt32LE(cursor + 42);
		const name = archive
			.subarray(cursor + 46, cursor + 46 + nameLength)
			.toString('utf8');
		if (archive.readUInt32LE(offset) !== LOCAL_HEADER) {
			throw new Error(`The local header of ${name} is malformed.`);
		}
		const localName = archive.readUInt16LE(offset + 26);
		const localExtra = archive.readUInt16LE(offset + 28);
		const start = offset + 30 + localName + localExtra;
		const data = archive.subarray(start, start + size);
		if (crc32(data) >>> 0 !== checksum) {
			throw new Error(`The checksum of ${name} does not match its data.`);
		}
		entries.push({ name, data: Buffer.from(data) });
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

export function jsonLines(entry: ZipEntry): readonly Record<string, unknown>[] {
	return entry.data
		.toString('utf8')
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}
