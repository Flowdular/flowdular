import { defineConfig } from 'vitest/config';

/* Booting the embedded PostgreSQL the tenant boundary case runs against takes
   seconds under parallel load, well past the 5s vitest default. */
export default defineConfig({
	test: {
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
