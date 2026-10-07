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

it('finds a session path after any separator, in a file URL and in quotes with spaces', () => {
	expect(
		redactText(`at file://${workspace}/modules/blog/tests/a.test.ts:3:5`),
	).toBe('at ./modules/blog/tests/a.test.ts:3:5');
	expect(
		redactText(`cwd:${workspace} [${workspace}/a.ts] <${workspace}>`),
	).toBe('cwd:. [./a.ts] <.>');
	expect(
		redactText(
			'cd "/Users/me/My Apps/blog/.flowdular/sandbox/sessions/x/workspace/modules/blog"',
		),
	).toBe('cd "./modules/blog"');
	expect(
		redactText(
			"'C:\\Users\\me\\My Apps\\blog\\.flowdular\\sandbox\\sessions\\id\\workspace\\modules\\a.ts'",
		),
	).toBe("'.\\modules\\a.ts'");
});

it('finds a session path whose directories hold separators', () => {
	for (const directory of ['proj(1)', 'a,b', '[work]', 'a=b'])
		expect(
			redactText(
				`at f (/Users/me/${directory}/blog/.flowdular/sandbox/sessions/x/workspace/a.ts:1:2)`,
			),
			directory,
		).toBe('at f (./a.ts:1:2)');
});

it('keeps the paths around a session path', () => {
	expect(
		redactText('PATH=/usr/bin:/Users/me/apps/blog/.flowdular/sandbox/bin'),
	).toBe('PATH=/usr/bin:.flowdular/sandbox/bin');
	expect(redactText(`copy /Users/me/src.ts->${workspace}/modules/a.ts`)).toBe(
		'copy /Users/me/src.ts->./modules/a.ts',
	);
	expect(
		redactText(
			`"/usr/bin/env node /Users/me/My Apps/blog/.flowdular/sandbox/sessions/x/workspace/a.js"`,
		),
	).toBe('"/usr/bin/env node ./a.js"');
	expect(
		redactText('see https://example.com/docs/.flowdular/sandbox/readme'),
	).toBe('see https://example.com/docs/.flowdular/sandbox/readme');
});

it('never reaches back past the path to an earlier one', () => {
	for (const text of [
		'cd /tmp && ls ~/apps/blog/.flowdular/sandbox',
		'cd /Users/me/x && ls ../blog/.flowdular/sandbox',
		'I ran /usr/bin/pnpm and saved ./.flowdular/ui-preview/list.png',
		'Moved /tmp/x to https://example.com/docs/.flowdular/x',
		'see /tmp/notes and Apps/blog/.flowdular/x',
		'"a" see /tmp/notes and Apps/blog/.flowdular/x',
	])
		expect(redactText(text), text).toBe(text);
	expect(
		redactText('/Users/me/.flowdular/x (see /tmp) and ~/blog/.flowdular/y'),
	).toBe('.flowdular/x (see /tmp) and ~/blog/.flowdular/y');
});

it('redacts a long line without spaces in linear time', () => {
	for (const unit of [
		'(/',
		'/.flowdular/',
		'a/.flowdular/',
		`${'a'.repeat(1_000)}/.flowdular/`,
		' /a/.flowdular/sandbox/sessions/x/workspace',
	]) {
		const started = performance.now();
		redactText(unit.repeat(Math.ceil(120_000 / unit.length)));
		expect(performance.now() - started, unit).toBeLessThan(2_000);
	}
});
