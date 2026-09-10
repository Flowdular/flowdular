import { defineConfig } from 'vitest/config';

// Server tests must not boot octane.config.ts and the live platform lifecycle.
export default defineConfig({
	test: { testTimeout: 30_000, hookTimeout: 30_000, maxWorkers: 2 },
});
