/** Insert only the module's explicit JSON DTO. Never serialize Context.state. */
export function webHtmlResponse(
	response: Response,
	url: string,
	data: unknown,
	nonce?: string,
): Response {
	const json = JSON.stringify({ url, data })
		.replace(/</g, '\\u003c')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
	const attribute =
		nonce && /^[a-zA-Z0-9+/=_-]+$/.test(nonce) ? ` nonce="${nonce}"` : '';
	const insert = `<script id="flowdular-web-data" type="application/json"${attribute}>${json}</script><style${attribute}>.flowdular-splash{display:none!important}html,body,#root{background:initial}</style>`;
	return injectHtmlHead(response, insert);
}

export function injectHtmlHead(response: Response, insert: string): Response {
	if (
		!response.body ||
		!response.headers.get('content-type')?.includes('text/html')
	)
		return response;
	let buffer = '';
	let inserted = false;
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const transform = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if (inserted) {
				controller.enqueue(
					encoder.encode(decoder.decode(chunk, { stream: true })),
				);
				return;
			}
			buffer += decoder.decode(chunk, { stream: true });
			const end = buffer.indexOf('</head>');
			if (end !== -1) {
				controller.enqueue(
					encoder.encode(buffer.slice(0, end) + insert + buffer.slice(end)),
				);
				buffer = '';
				inserted = true;
			} else if (buffer.length > 262144)
				throw new Error('Web page head exceeds the supported bound.');
		},
		flush(controller) {
			controller.enqueue(encoder.encode(buffer + decoder.decode()));
		},
	});
	const headers = new Headers(response.headers);
	headers.delete('content-length');
	headers.delete('etag');
	return new Response(response.body.pipeThrough(transform), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
