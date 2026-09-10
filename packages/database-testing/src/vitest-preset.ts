import { defineConfig, type ViteUserConfig } from 'vitest/config';

/**
 * Shared test configuration for any suite that boots the embedded PostgreSQL.
 *
 * Booting it costs a second or two on an idle machine and considerably more
 * when the whole workspace runs at once, which is well past the 5s vitest
 * default. Every consumer extends this instead of restating the numbers, so a
 * suite cannot silently miss the raised timeout and fail only in a full run.
 */
export function definePgliteTestConfig(
	overrides: ViteUserConfig = {},
): ViteUserConfig {
	return defineConfig({
		...overrides,
		test: {
			maxWorkers: 2,
			testTimeout: 30_000,
			hookTimeout: 30_000,
			...overrides.test,
		},
	});
}
