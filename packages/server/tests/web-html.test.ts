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

function page(): Response {
	return new Response(
		'<html><head><title>Post</title></head><body>One</body></html>',
		{
			headers: { 'content-type': 'text/html' },
		},
	);
}

it('serves a built page with nothing between its markup and its stylesheets', async () => {
	const html = await webHtmlResponse(
		page(),
		'/post/one',
		{ title: 'One' },
		undefined,
		false,
	).text();
	expect(html).not.toContain('flowdular-web-pending');
	expect(html).toContain('flowdular-web-data');
});

it('holds a development page behind its background until a stylesheet lands', async () => {
	const html = await webHtmlResponse(
		page(),
		'/post/one',
		{ title: 'One' },
		undefined,
		true,
	).text();
	/* The cover hides the one unstyled frame the module graph would paint, and
	   removes itself on the first stylesheet Vite injects. */
	expect(html).toContain('<style id="flowdular-web-pending"');
	expect(html).toContain('body{visibility:hidden}');
	expect(html).toContain('data-vite-dev-id');
	expect(html).toContain('MutationObserver');
});

it('carries the content security nonce on everything it injects', async () => {
	const html = await webHtmlResponse(
		page(),
		'/post/one',
		{ title: 'One' },
		'abc123',
		true,
	).text();
	const injected = (html.match(/<(?:style|script)[^>]*>/g) ?? []).filter(
		(tag) => !tag.includes('<title'),
	);
	expect(injected.length).toBeGreaterThanOrEqual(4);
	for (const tag of injected) expect(tag).toContain('nonce="abc123"');
});
