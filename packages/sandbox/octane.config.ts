import { defineConfig } from '@octanejs/vite-plugin';
import { sandboxRenderRoutes } from './src/render-routes.ts';
import { createSandboxRoutes } from './src/server/routes.ts';
import { processPreviewRuntime } from './src/server/preview-runtime.ts';
import { createSandboxRuntime } from './src/server/runtime.ts';
import { findFlowdularWorkspace } from './src/server/workspace-root.ts';

const workspace = await findFlowdularWorkspace(
	process.env.FD_SANDBOX_WORKSPACE ?? process.cwd(),
);
const runtime = await createSandboxRuntime(workspace.root);
/* Server route modules are reevaluated during HMR. The preview runtime belongs
   to the Vite process so each generation reuses the same session workers. */
const preview = processPreviewRuntime(workspace.root);

export default defineConfig({
	router: {
		routes: [
			...sandboxRenderRoutes(),
			...createSandboxRoutes(runtime, preview, {
				...(process.env.FD_SANDBOX_PORT
					? { port: Number(process.env.FD_SANDBOX_PORT) }
					: {}),
			}),
		],
	},
});
