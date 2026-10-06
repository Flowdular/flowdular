import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { replaceLocalFile } from '../local-file.ts';
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
	await replaceLocalFile(
		recordPath(sessionRoot),
		`${JSON.stringify(record, null, '\t')}\n`,
	);
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
