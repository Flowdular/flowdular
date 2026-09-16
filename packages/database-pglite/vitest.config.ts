import { defineConfig } from 'vitest/config';

/* The same limits as definePgliteTestConfig in @flowdular/database-testing,
   restated here because that package depends on this one. */
export default defineConfig({
	test: {
		maxWorkers: 2,
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
