import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runDoctor } from '../src/doctor.ts';

const ENTRY_WITH_BRANDING = `import { configureBrandingFromPage } from '@flowdular/sdk/client';
export function App(props) {
	configureBrandingFromPage(props);
}
`;
const ENTRY_WITHOUT_BRANDING = `export function App() {}\n`;
const PAGE_STATIC_HEAD = `<!doctype html>
<html><head>
<meta name="theme-color" content="#141B2E" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
</head><body></body></html>
`;
const PAGE_RENDERED_HEAD = `<!doctype html>
<html><head><!--ssr-head--></head><body></body></html>
`;

async function branding(
	entry: string | null,
	page: string,
): Promise<{ readonly status?: string; readonly message?: string }> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-doctor-branding-'));
	try {
		await mkdir(join(root, 'platform/src'), { recursive: true });
		await mkdir(join(root, '.ai/blueprints'), { recursive: true });
		if (entry !== null)
			await writeFile(join(root, 'platform/src/App.tsrx'), entry);
		await writeFile(join(root, 'platform/index.html'), page);
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'app', packageManager: 'pnpm@11.17.0' }),
		);
		const configPath = join(root, 'flowdular.json');
		const config = { schemaVersion: 1, modules: { enabled: [] } };
		await writeFile(configPath, JSON.stringify(config));
		const checks = await runDoctor({ root, configPath, config } as never);
		return checks.find((check) => check.id === 'platform.branding') ?? {};
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

it('passes an application that renders the branding and nothing static', async () => {
	const check = await branding(ENTRY_WITH_BRANDING, PAGE_RENDERED_HEAD);
	expect(check.status).toBe('pass');
});

/* The upgrade an application scaffolded before the branding release needs. */
it('warns when the entry renders no branding', async () => {
	const check = await branding(ENTRY_WITHOUT_BRANDING, PAGE_STATIC_HEAD);
	expect(check.status).toBe('warn');
	expect(check.message).toContain('configureBrandingFromPage');
});

/* Halfway through that upgrade the head carries two answers. */
it('warns when a static icon or theme colour competes with the rendered one', async () => {
	const check = await branding(ENTRY_WITH_BRANDING, PAGE_STATIC_HEAD);
	expect(check.status).toBe('warn');
	expect(check.message).toContain('two answers');
});

it('says nothing about a workspace with no application entry', async () => {
	const check = await branding(null, PAGE_RENDERED_HEAD);
	expect(check.status).toBeUndefined();
});
