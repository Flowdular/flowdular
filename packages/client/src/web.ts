/** Synchronous SSR/hydration data. Only the page loader's explicit DTO is present. */
export function webPageData<T>(props: {
	readonly url: string;
	readonly state?: Map<string, unknown>;
}): T {
	if (props.state?.has('flowdular.web.data'))
		return props.state.get('flowdular.web.data') as T;
	if (typeof document !== 'undefined') {
		const element = document.getElementById('flowdular-web-data');
		if (element?.textContent) {
			const initial = JSON.parse(element.textContent) as {
				url: string;
				data: T;
			};
			if (initial.url === props.url) return initial.data;
		}
	}
	throw new Error(
		'Web page data is unavailable. Render this page through its configured module surface.',
	);
}

/** Explicit fetch for navigation or refresh. Reuses the page's access and tenant guards. */
export async function loadWebPage<T>(
	url: string,
	signal?: AbortSignal,
): Promise<T> {
	const response = await fetch(url, {
		headers: { accept: 'application/vnd.flowdular.page+json' },
		credentials: 'same-origin',
		cache: 'no-store',
		...(signal ? { signal } : {}),
	});
	if (!response.ok)
		throw new Error(`Page request failed (${response.status}).`);
	if (!response.headers.get('content-type')?.startsWith('application/json'))
		throw new Error('Invalid page response.');
	return (await response.json()) as T;
}
