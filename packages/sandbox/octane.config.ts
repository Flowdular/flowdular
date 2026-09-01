import { defineConfig, RenderRoute } from '@octanejs/vite-plugin';
import { createSandboxRoutes } from './src/server/routes.ts';
import { createPreviewRuntime } from './src/server/preview-runtime.ts';
import { createSandboxRuntime } from './src/server/runtime.ts';
import { findCoreloomWorkspace } from './src/server/workspace-root.ts';

const SHELL = ['App', '/src/App.tsrx'] as const;
const PREVIEW = ['PreviewHost', '/src/preview/PreviewHost.tsrx'] as const;

const workspace = await findCoreloomWorkspace(
	process.env.CORELOOM_WORKSPACE ?? process.cwd(),
);
const runtime = await createSandboxRuntime(workspace.root);
const preview = createPreviewRuntime(workspace.root);

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
				...(process.env.CORELOOM_SANDBOX_PORT
					? { port: Number(process.env.CORELOOM_SANDBOX_PORT) }
					: {}),
			}),
		],
	},
});
