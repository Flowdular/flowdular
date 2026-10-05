import { octane } from 'octane/compiler/vite';
import { defineConfig } from 'vitest/config';

/* Booting the embedded PostgreSQL a suite runs against takes seconds under
   parallel load, well past the 5s vitest default.

   Deliberately self-contained. A sandbox session copies this module into its
   own workspace and runs these gates there, so importing a shared preset from
   another workspace package would leave vitest unable to load its config in
   that copy. The duplication is the price of that isolation; keep it. */
export default defineConfig({
	plugins: [octane({ ssr: false })],
	resolve: {
		extensions: ['.tsrx', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
	},
	test: {
		include: ['tests/**/*.test.ts', 'tests/**/*.test.tsrx'],
		maxWorkers: 2,
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
