const ADDRESS_PATTERN = /^[0-9a-fA-F.:]{3,45}$/;

/* Octane hands routes a Web Request without the socket address, so the client
   address is only known behind a reverse proxy that is explicitly trusted to
   set x-forwarded-for. Callers skip address-based limits on null. */
export function clientAddress(
	request: Request,
	trustProxy: boolean,
): string | null {
	if (!trustProxy) return null;
	const forwarded = request.headers.get('x-forwarded-for');
	const first = forwarded?.split(',')[0]?.trim() ?? '';
	return ADDRESS_PATTERN.test(first) ? first.toLowerCase() : null;
}
