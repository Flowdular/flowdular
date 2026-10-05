/* Vercel assigns a different origin to every preview. Read its own deployment
   hostname before importing Octane, whose auth runtime captures the origin at boot. */
process.env.NODE_ENV = 'production';
process.env.FD_DEPLOYMENT_TARGET = 'vercel';
process.env.FD_TRUST_PROXY = 'true';
process.env.FD_AUTH_SECURE_COOKIE = 'true';
if (!process.env.FD_AUTH_PUBLIC_ORIGIN && process.env.VERCEL_URL) {
	const host = process.env.VERCEL_URL;
	if (
		!/^[-a-z0-9.]+$/i.test(host) ||
		host.startsWith('.') ||
		host.endsWith('.') ||
		host.includes('..') ||
		!host.includes('.')
	) {
		throw new Error('VERCEL_URL must be a hostname without a scheme or path.');
	}
	process.env.FD_AUTH_PUBLIC_ORIGIN = `https://${host}`;
}

const { nodeHandler } = await import('./platform/dist/server/entry.js');

export default nodeHandler;
