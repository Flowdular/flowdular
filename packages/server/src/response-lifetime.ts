/** Own resources until the consumer finishes or cancels the response body. */
export function trackResponseBody(
	response: Response,
	release: () => void,
	signal?: AbortSignal,
): Response {
	if (!response.body) {
		release();
		return response;
	}
	const reader = response.body.getReader();
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		signal?.removeEventListener('abort', abort);
		release();
	};
	const abort = () => {
		void reader
			.cancel(signal?.reason)
			.catch(() => undefined)
			.finally(finish);
	};
	signal?.addEventListener('abort', abort, { once: true });
	if (signal?.aborted) abort();
	const body = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const chunk = await reader.read();
					if (chunk.done) {
						controller.close();
						finish();
					} else controller.enqueue(chunk.value);
				} catch (error) {
					controller.error(error);
					finish();
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					finish();
				}
			},
		},
		{ highWaterMark: 0 },
	);
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
