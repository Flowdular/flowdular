import { defineConfig, RenderRoute } from '@octanejs/vite-plugin';

const PAGE = ['App', '/src/App.tsrx'] as const;

/* One server-rendered page. The landing is a public marketing site: no
   session, no database, no module composition. */
export default defineConfig({
	router: {
		routes: [new RenderRoute({ path: '/', entry: PAGE })],
	},
});
