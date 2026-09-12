import { defineConfig } from 'vitest/config';

/* Booting the embedded PostgreSQL a suite runs against takes seconds under
   parallel load, well past the 5s vitest default. Every file here starts its
   own engine, so the worker count is capped too: past that the engines contend
   for memory and a query fails for a reason that has nothing to do with the
   code under test. */
export default defineConfig({
	test: {
		maxWorkers: 2,
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
