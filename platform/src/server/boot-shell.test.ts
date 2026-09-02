import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('initial HTML shell', () => {
	it('renders an accessible splash outside the hydration root', async () => {
		const html = await readFile(
			new URL('../../index.html', import.meta.url),
			'utf8',
		);
		expect(html.indexOf('id="coreloom-splash"')).toBeLessThan(
			html.indexOf('id="root"'),
		);
		expect(html).toContain('role="status"');
		expect(html).toContain("window.addEventListener('coreloom:ready', finish");
		expect(html).toContain("'Selecting workspace'");
		expect(html).toContain("'Loading modules'");
		expect(html).toContain("'Preparing workspace'");
		expect(html).not.toContain('requestAnimationFrame(() =>');
		expect(html).toMatch(
			/<noscript[\s\S]*\.coreloom-splash\s*{\s*display:\s*none;/,
		);
	});
});
