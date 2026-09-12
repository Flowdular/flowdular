import { octane } from 'octane/compiler/vite';
import { defineConfig } from 'vitest/config';

/* The shell is `.tsrx`, so a render assertion needs the octane compiler and a
   DOM, the same way the shared primitives are tested. */
export default defineConfig({
	plugins: [octane({ ssr: false })],
	resolve: {
		extensions: ['.tsrx', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
	},
	test: {
		environment: 'jsdom',
		include: ['tests/**/*.test.ts', 'tests/**/*.test.tsrx'],
	},
});
