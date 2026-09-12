import { octane } from 'octane/compiler/vite';
import { defineConfig } from 'vitest/config';

/* The primitives are `.tsrx` components, so a render assertion needs both the
   octane compiler and a DOM. `ssr: false` is explicit: client code generation
   is what `createRoot` mounts, and a silently server-rendered module would
   produce strings instead of nodes.

   Deliberately self-contained, like every other workspace vitest config. */
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
