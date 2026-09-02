import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { octane } from '@octanejs/vite-plugin';
import { defineConfig } from 'vite';

const appRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: appRoot,
	plugins: [octane()],
	envPrefix: ['VITE_', 'CL_'],
	resolve: {
		extensions: ['.tsrx', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
	},
	build: { target: 'esnext' },
	server: {
		host: '127.0.0.1',
		port: Number(process.env.CL_LANDING_PORT ?? 4330),
		strictPort: true,
	},
});
