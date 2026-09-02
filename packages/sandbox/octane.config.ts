import { defineConfig, RenderRoute } from '@octanejs/vite-plugin';
import { createSandboxRoutes } from './src/server/routes.ts';
import { processPreviewRuntime } from './src/server/preview-runtime.ts';
import { createSandboxRuntime } from './src/server/runtime.ts';
import { findCoreloomWorkspace } from './src/server/workspace-root.ts';

const SHELL = ['App', '/src/App.tsrx'] as const;
const PREVIEW = ['PreviewHost', '/src/preview/PreviewHost.tsrx'] as const;

const workspace = await findCoreloomWorkspace(
	process.env.CL_SANDBOX_WORKSPACE ?? process.cwd(),
);
const runtime = await createSandboxRuntime(workspace.root);
/* Server route modules are reevaluated during HMR. The preview runtime belongs
   to the Vite process so each generation reuses the same session workers. */
const preview = processPreviewRuntime(workspace.root);

export default defineConfig({
	router: {
		routes: [
			new RenderRoute({ path: '/', entry: SHELL }),
			new RenderRoute({ path: '/sessions/:id', entry: SHELL }),
			new RenderRoute({ path: '/settings', entry: SHELL }),
			/* The preview renders one draft module inside the application shell,
			   in its own document, so the chat and the preview cannot share state
			   by accident. */
			new RenderRoute({ path: '/preview/:sessionId', entry: PREVIEW }),
			new RenderRoute({ path: '/preview/:sessionId/:view', entry: PREVIEW }),
			...createSandboxRoutes(runtime, preview, {
				...(process.env.CL_SANDBOX_PORT
					? { port: Number(process.env.CL_SANDBOX_PORT) }
					: {}),
			}),
		],
	},
});
