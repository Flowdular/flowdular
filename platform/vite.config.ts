import { octane } from '@octanejs/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [octane()],
	resolve: {
		extensions: ['.tsrx', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
	},
	build: { target: 'esnext' },
	server: {
		port: 4310,
		strictPort: true,
		hmr: true,
		watch: { ignored: ['**/.coreloom/data/**'] },
	},
});
