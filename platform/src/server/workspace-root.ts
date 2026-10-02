import { basename, dirname } from 'node:path';

export function findWorkspaceRoot(start: string): string {
	/* Development loads platform/octane.config.ts from platform/. The production
	   bundle loads it from platform/dist/server/, including in Docker. */
	if (basename(start) === 'platform') return dirname(start);
	const dist = dirname(start);
	const platform = dirname(dist);
	if (
		basename(start) === 'server' &&
		basename(dist) === 'dist' &&
		basename(platform) === 'platform'
	)
		return dirname(platform);
	throw new Error('Unexpected Flowdular platform entry layout.');
}
