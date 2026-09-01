import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EjectTarget } from './types.ts';

/* What a delivery left behind that the session record does not carry: the
   branch and the pull request, so a session can be reopened to its review. */
export interface DeliveryRecord {
	readonly target: EjectTarget;
	readonly deliveredAt: number;
	readonly modules: readonly string[];
	readonly branch: string | null;
	readonly pullRequestUrl: string | null;
	readonly compareUrl: string | null;
}

function recordPath(sessionRoot: string): string {
	return join(sessionRoot, 'delivery.json');
}

export async function writeDeliveryRecord(
	sessionRoot: string,
	record: DeliveryRecord,
): Promise<DeliveryRecord> {
	const path = recordPath(sessionRoot);
	const staging = `${path}.${process.pid}`;
	await writeFile(staging, `${JSON.stringify(record, null, '\t')}\n`, 'utf8');
	await rename(staging, path);
	return record;
}

export async function readDeliveryRecord(
	sessionRoot: string,
): Promise<DeliveryRecord | null> {
	try {
		return JSON.parse(
			await readFile(recordPath(sessionRoot), 'utf8'),
		) as DeliveryRecord;
	} catch {
		return null;
	}
}
