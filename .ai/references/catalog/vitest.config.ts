import { defineConfig } from 'vitest/config';

/* Booting the embedded PostgreSQL a suite runs against takes seconds under
   parallel load, well past the 5s vitest default.

   Deliberately self-contained. A sandbox session copies this module into its
   own workspace and runs these gates there, so importing a shared preset from
   another workspace package would leave vitest unable to load its config in
   that copy. The duplication is the price of that isolation; keep it. */
export default defineConfig({
	test: {
		maxWorkers: 2,
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
