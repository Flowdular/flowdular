import { expect, it } from 'vitest';
import { webHtmlResponse } from '../src/web-html.ts';

it('preserves split UTF-8 bytes after inserting hydration data across streamed head chunks', async () => {
	const prefix = new TextEncoder().encode(
		'<html><head><title>Title</title></head><body>',
	);
	const unicode = new TextEncoder().encode('Zażółć 🧩');
	const all = new Uint8Array([
		...prefix,
		...unicode,
		...new TextEncoder().encode('</body></html>'),
	]);
	const chunks = [
		all.slice(0, 12),
		all.slice(12, prefix.length + 3),
		all.slice(prefix.length + 3, prefix.length + 4),
		all.slice(prefix.length + 4),
	];
	const body = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	const response = webHtmlResponse(
		new Response(body, { headers: { 'content-type': 'text/html' } }),
		'/blog',
		{ title: 'Zażółć' },
		'test-nonce',
	);
	const html = await response.text();
	expect(html).toContain('Zażółć 🧩</body>');
	expect(html).toContain('nonce="test-nonce"');
	expect(html).toContain('"url":"/blog"');
	expect(html).not.toContain('�');
});
