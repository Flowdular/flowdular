import type { AnchorSigner } from './anchor-key.ts';
import type { AuditRepository } from './repository.ts';

/** Anchors re-signed per routing page. */
export const ANCHOR_ROTATION_BATCH = 200;

/** Anchor ids one report names, so a broken ring does not print a table. */
export const ANCHOR_ROTATION_REPORT_LIMIT = 50;

export interface AnchorKeyCountReport {
	readonly keyId: string;
	readonly anchors: number;
}

export interface AnchorRotationReport {
	readonly table: string;
	/** Key id every anchor should end on: the current key of the signer. */
	readonly currentKeyId: string;
	readonly counts: readonly AnchorKeyCountReport[];
	/** Anchors on a retired key when the run started. */
	readonly stale: number;
	readonly rotated: number;
	/** Anchors another process re-signed between the read and the update. */
	readonly skipped: number;
	/** Anchors whose recorded key is in no ring, which a re-sign cannot fix. */
	readonly unknownKeys: readonly string[];
	/**
	 * Anchors whose stored signature does not verify under the ring, by id and
	 * bounded by `ANCHOR_ROTATION_REPORT_LIMIT`. None of them is re-signed: a
	 * signature that does not verify is evidence, and signing the anchor hash
	 * again would replace that evidence with a valid signature of this
	 * deployment's own making.
	 */
	readonly unverified: readonly string[];
	/** How many failed to verify, including the ones past the report limit. */
	readonly unverifiedCount: number;
}

export interface AnchorRotationOptions {
	readonly repository: AuditRepository;
	readonly signer: AnchorSigner;
	readonly apply?: boolean;
	readonly batchSize?: number;
}

/**
 * Re-signs every anchor that is not on the current key, once its stored
 * signature verifies under the ring. Only the signature and the key id change:
 * the anchor hash, the segment hash and the chain are what the segment files
 * already carry, so a re-signed anchor still verifies against a file written
 * years ago. It is idempotent, so a second run finds nothing.
 */
export async function rotateAnchorSignatures(
	options: AnchorRotationOptions,
): Promise<AnchorRotationReport> {
	const currentKeyId = options.signer.keyId;
	const batchSize = options.batchSize ?? ANCHOR_ROTATION_BATCH;
	const counts = await options.repository.countAnchorsByKey();
	const stale = counts.reduce(
		(total, entry) =>
			entry.keyId === currentKeyId ? total : total + entry.anchors,
		0,
	);
	const unknownKeys = counts
		.filter(
			(entry) =>
				entry.keyId !== currentKeyId && !options.signer.knows(entry.keyId),
		)
		.map((entry) => entry.keyId);
	const report = {
		table: 'audit_anchors',
		currentKeyId,
		counts: counts.map((entry) => ({
			keyId: entry.keyId,
			anchors: entry.anchors,
		})),
		stale,
		unknownKeys,
	};
	if (options.apply !== true) {
		return {
			...report,
			rotated: 0,
			skipped: 0,
			unverified: [],
			unverifiedCount: 0,
		};
	}
	let rotated = 0;
	let skipped = 0;
	let unverifiedCount = 0;
	const unverified: string[] = [];
	let cursor = '';
	for (;;) {
		/* Paged by primary key: an anchor the optimistic update skipped stays
		   stale, so a query that only asked for stale rows would return it for
		   ever. The routing read sees the tenant, the id and the key id alone. */
		const page = await options.repository.listAnchorsNotOnKey(
			currentKeyId,
			cursor,
			batchSize,
		);
		for (const routing of page) {
			cursor = routing.id;
			/* Read again under the workspace the routing row named; the anchor
			   hash it signs is never visible to the cross-tenant lease. */
			const anchor = await options.repository.getAnchor(
				routing.tenantId,
				routing.id,
			);
			if (!anchor || anchor.keyId === currentKeyId) {
				skipped += 1;
				continue;
			}
			/* A signature is re-made only once the stored one is proved. A key the
			   ring does not hold, or an anchor whose signature does not verify
			   under the key it names, is reported and left exactly as it is: a new
			   signature over the same anchor hash would turn a row nobody can
			   account for into one this deployment vouches for. */
			if (
				!options.signer.knows(anchor.keyId) ||
				!options.signer.verify(
					anchor.anchorHash,
					anchor.signature,
					anchor.keyId,
				)
			) {
				unverifiedCount += 1;
				if (unverified.length < ANCHOR_ROTATION_REPORT_LIMIT) {
					unverified.push(anchor.id);
				}
				continue;
			}
			const written = await options.repository.resignAnchor({
				tenantId: anchor.tenantId,
				id: anchor.id,
				signature: options.signer.sign(anchor.anchorHash),
				keyId: currentKeyId,
				expectedSignature: anchor.signature,
			});
			if (written) rotated += 1;
			else skipped += 1;
		}
		if (page.length < batchSize) break;
	}
	return { ...report, rotated, skipped, unverified, unverifiedCount };
}
