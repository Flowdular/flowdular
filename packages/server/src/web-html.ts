/* Development serves stylesheets through the module graph, so a page paints
   before its own CSS exists. The shell hides that behind its boot splash; a
   public page removes the splash, because its content is the point and in a
   built application that content arrives already dressed. What is left in
   development is one unstyled frame, so the page waits behind its own
   background instead: Vite marks every stylesheet it injects, and the first
   one to land reveals the document. The bound is what a page with no CSS of
   its own waits, and nothing here reaches a built application. */
const STYLE_WAIT_MS = 1_500;

function pendingStyles(attribute: string): string {
	return (
		`<style id="flowdular-web-pending"${attribute}>body{visibility:hidden}</style>` +
		`<script${attribute}>(()=>{const c=()=>document.querySelector('style[data-vite-dev-id],link[rel="stylesheet"]');` +
		`const r=()=>{o.disconnect();clearTimeout(t);document.getElementById('flowdular-web-pending')?.remove()};` +
		`const o=new MutationObserver(()=>{if(c())requestAnimationFrame(r)});` +
		`const t=setTimeout(r,${STYLE_WAIT_MS});` +
		`if(c())r();else o.observe(document.head,{childList:true})})()</script>`
	);
}

/** Insert only the module's explicit JSON DTO. Never serialize Context.state. */
export function webHtmlResponse(
	response: Response,
	url: string,
	data: unknown,
	nonce?: string,
	development = false,
): Response {
	const json = JSON.stringify({ url, data })
		.replace(/</g, '\\u003c')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
	const attribute =
		nonce && /^[a-zA-Z0-9+/=_-]+$/.test(nonce) ? ` nonce="${nonce}"` : '';
	const insert =
		`<script id="flowdular-web-data" type="application/json"${attribute}>${json}</script>` +
		`<style${attribute}>.flowdular-splash{display:none!important}html,body,#root{background:initial}</style>` +
		(development ? pendingStyles(attribute) : '');
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
