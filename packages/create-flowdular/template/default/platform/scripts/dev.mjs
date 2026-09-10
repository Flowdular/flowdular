import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const server = await createServer({
	root: appRoot,
	configFile: resolve(appRoot, 'vite.config.ts'),
});
await server.listen();
server.printUrls();

/* Closing without exiting lets octane.config.ts release the database on the
   same signal; the process ends once both have drained. */
const stop = () => void server.close();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
