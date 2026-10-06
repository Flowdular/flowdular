import { createRouter } from '@octanejs/app-core';
import { describe, expect, it } from 'vitest';
import { readPreviewAddress } from '../src/preview/address.ts';
import { sandboxRenderRoutes } from '../src/render-routes.ts';

const SESSION = '8f7a170f-35d5-4d1b-853a-16c3bebf6b89';
const OTHER = '00000000-0000-4000-8000-000000000001';

describe('reloading a page inside the preview', () => {
	const router = createRouter(sandboxRenderRoutes());
	const documentAt = (pathname: string) => {
		const match = router.match('GET', pathname);
		return match?.route.type === 'render' ? match.route.entry : null;
	};
	const preview = documentAt(`/preview/${SESSION}`);

	it('answers the addresses the shell writes with the preview document', () => {
		expect(preview).not.toBeNull();
		for (const pathname of [
			'/app',
			'/app/preview',
			'/app/preview/equipment',
			'/app/equipment',
		]) {
			expect(documentAt(pathname), pathname).toBe(preview);
		}
		expect(documentAt('/')).not.toBe(preview);
		expect(documentAt(`/sessions/${SESSION}`)).toBe(documentAt('/'));
	});

	it('reopens the session the preview cookie holds', () => {
		expect(
			readPreviewAddress(
				'/app/preview/equipment?n=3&module=equipment',
				`flowdular_locale=en; flowdular_preview=${SESSION}`,
			),
		).toEqual({ sessionId: SESSION, inShell: true });
		/* The address that opened the preview names its session itself. */
		expect(
			readPreviewAddress(
				`/preview/${SESSION}?module=equipment`,
				`flowdular_preview=${OTHER}`,
			),
		).toEqual({ sessionId: SESSION, inShell: false });
	});

	it('names no session when nothing trustworthy holds one', () => {
		expect(readPreviewAddress('/app/preview/equipment', '')).toEqual({
			sessionId: '',
			inShell: true,
		});
		expect(
			readPreviewAddress('/app/equipment', 'flowdular_preview=../../state'),
		).toEqual({ sessionId: '', inShell: true });
		expect(
			readPreviewAddress('/settings', `flowdular_preview=${SESSION}`),
		).toEqual({ sessionId: '', inShell: false });
	});
});
