import { applicationPath } from '@flowdular/client/routing';
import { RenderRoute } from '@octanejs/vite-plugin';

const SHELL = ['App', '/src/App.tsrx'] as const;
const PREVIEW = ['PreviewHost', '/src/preview/PreviewHost.tsrx'] as const;

export function sandboxRenderRoutes(): RenderRoute[] {
	return [
		new RenderRoute({ path: '/', entry: SHELL }),
		new RenderRoute({ path: '/sessions/:id', entry: SHELL }),
		new RenderRoute({ path: '/settings', entry: SHELL }),
		/* The preview renders one draft module inside the application shell,
		   in its own document, so the chat and the preview cannot share state
		   by accident. */
		new RenderRoute({ path: '/preview/:sessionId', entry: PREVIEW }),
		new RenderRoute({ path: '/preview/:sessionId/:view', entry: PREVIEW }),
		/* Once open, the shell moves the address to its own routes, so a
		   reload or a deep link inside the preview arrives here. */
		new RenderRoute({ path: applicationPath(), entry: PREVIEW }),
		new RenderRoute({ path: `${applicationPath()}/*path`, entry: PREVIEW }),
	];
}
