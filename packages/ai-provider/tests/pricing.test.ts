import { describe, expect, it } from 'vitest';
import {
	modelPrice,
	unpricedCatalogModels,
	usageCostMicros,
} from '../src/pricing.ts';

describe('model pricing', () => {
	it('prices every model the catalog names', () => {
		expect(unpricedCatalogModels()).toEqual([]);
	});

	it('costs a known model from its published rate', () => {
		/* Opus 5 lists $5 per million input and $25 per million output. */
		expect(
			usageCostMicros('claude-opus-5', {
				inputTokens: 1_000_000,
				outputTokens: 1_000_000,
			}),
		).toBe(30_000_000);
		expect(
			usageCostMicros('claude-haiku-4-5', {
				inputTokens: 1_000,
				outputTokens: 2_000,
			}),
		).toBe(11_000);
	});

	it('resolves a gateway-qualified identifier to the same price', () => {
		expect(modelPrice('anthropic/claude-sonnet-5')).toEqual(
			modelPrice('claude-sonnet-5'),
		);
	});

	it('leaves an unknown model unpriced instead of guessing', () => {
		expect(modelPrice('deterministic-v1')).toBeNull();
		expect(
			usageCostMicros('some-private-deployment', {
				inputTokens: 10_000,
				outputTokens: 10_000,
			}),
		).toBeNull();
	});

	it('ignores negative and fractional token counts', () => {
		expect(
			usageCostMicros('claude-sonnet-5', {
				inputTokens: -5,
				outputTokens: 1.9,
			}),
		).toBe(10);
	});
});
