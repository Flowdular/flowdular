import { expect, it } from 'vitest';
import { redactText } from '../src/server/sessions.ts';

const workspace =
	'/Users/me/apps/blog/.flowdular/sandbox/sessions/01c8-f8/workspace';

it('stores session paths relative to the workspace, never the local home', () => {
	expect(redactText(`cd ${workspace}/modules/blog && pnpm test`)).toBe(
		'cd ./modules/blog && pnpm test',
	);
	expect(redactText(`cd ${workspace} && pnpm install`)).toBe(
		'cd . && pnpm install',
	);
	expect(
		redactText(
			`Command: ${workspace}/modules/blog/node_modules/.bin/tsrx-tsc --noEmit`,
		),
	).toBe('Command: ./modules/blog/node_modules/.bin/tsrx-tsc --noEmit');
	expect(redactText(`Read "${workspace}/reference/guide.md".`)).toBe(
		'Read "./reference/guide.md".',
	);
	expect(
		redactText(
			'Evidence was quarantined at /Users/me/apps/blog/.flowdular/sandbox/sessions/01c8-f8/quarantine/1.',
		),
	).toBe(
		'Evidence was quarantined at .flowdular/sandbox/sessions/01c8-f8/quarantine/1.',
	);
	expect(
		redactText(
			'C:\\Users\\me\\blog\\.flowdular\\sandbox\\sessions\\id\\workspace\\modules\\a.ts',
		),
	).toBe('.\\modules\\a.ts');
	expect(redactText('modules/blog/src/api.ts and /tmp/other.ts')).toBe(
		'modules/blog/src/api.ts and /tmp/other.ts',
	);
});
