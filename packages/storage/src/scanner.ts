import type { StorageScanVerdict } from './contracts.ts';

export interface StorageScanResult {
	readonly verdict: StorageScanVerdict;
}

/**
 * The seam a deployment fills with a malware scanner. It reads the plaintext
 * stream and answers with a verdict; the platform refuses `infected` and stores
 * the verdict with the object so a later policy change can find what was never
 * scanned.
 */
export interface StorageScanner {
	scan(
		body: ReadableStream<Uint8Array>,
	): StorageScanResult | Promise<StorageScanResult>;
}

/** No scanner configured. Every object is stored with the `unscanned` verdict. */
export const unscannedStorageScanner: StorageScanner = Object.freeze({
	scan: () => ({ verdict: 'unscanned' as const }),
});
