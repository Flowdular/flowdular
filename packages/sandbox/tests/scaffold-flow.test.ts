import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
	createCodingAgentRegistry,
	DEFAULT_AGENT_ROLES,
} from '@flowdular/coding-agent';
import {
	createSession,
	approveSpecification,
	sessionPaths,
} from '../src/server/sessions.ts';
import { scaffoldFromSpec, type TurnContext } from '../src/server/turns.ts';
import { DEFAULT_CONFIGURATION } from '../src/server/config.ts';

it('creates a real module through the checkout CLI only after approval, merging business-manager translations into the skeleton', async () => {
	const repository = fileURLToPath(new URL('../../../', import.meta.url));
	const root = await mkdtemp(join(tmpdir(), 'flowdular-scaffold-flow-'));
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { enabled: [] } }),
	);
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({
			private: true,
			scripts: {
				flowdular: `pnpm --dir ${JSON.stringify(repository)} --silent flowdular`,
			},
		}),
	);
	const session = await createSession({
		workspaceRoot: root,
		kind: 'new-module',
		moduleId: 'booking.core',
		title: 'Bookings',
		brief: 'Book meeting rooms.',
		blueprint: 'new-module@1.0.0',
		role: 'business-manager',
		driver: 'fake',
		install: false,
	});
	const paths = sessionPaths(root, session.id, session.moduleSuffix);
	await mkdir(join(paths.modulePath, 'spec'), { recursive: true });
	await mkdir(join(paths.modulePath, 'translations'), { recursive: true });
	const spec = `schemaVersion: 1
id: booking.core
specVersion: 0.1.0
status: draft
name: Booking
description: Tenant-owned meeting room reservations.
profile: full
capabilities: [api, database, client, translations]
dependencies: []
tenancy: required
locales: [en, pl]
invariants: [Every booking belongs to one tenant.]
permissions:
  - id: booking.items.read
    description: Read bookings.
  - id: booking.items.manage
    description: Manage bookings.
dataOwnership: [booking.core owns room reservations.]
acceptanceScenarios:
  - id: BOOKING-LIST
    given: A tenant has bookings.
    when: An authorized user lists them.
    then: Only their tenant bookings are returned.
`;
	await writeFile(join(paths.modulePath, 'spec/module.yaml'), spec);
	await writeFile(
		join(paths.modulePath, 'translations/en.json'),
		'{"business.custom":"Room booking","page.title":"Room bookings"}\n',
	);
	await writeFile(
		join(paths.modulePath, 'translations/pl.json'),
		'{"business.custom":"Rezerwacja sali","page.title":"Rezerwacje sal"}\n',
	);
	const context: TurnContext = {
		workspaceRoot: root,
		configuration: DEFAULT_CONFIGURATION,
		registry: createCodingAgentRegistry({ mode: 'loopback', drivers: [] }),
		roles: DEFAULT_AGENT_ROLES,
		platform: null,
	};
	await scaffoldFromSpec(context, session);
	await expect(
		stat(join(paths.modulePath, 'module.json')),
	).rejects.toMatchObject({ code: 'ENOENT' });
	// An explicit operator decision on this synthetic test spec, never a host module.
	const approved = await approveSpecification(root, session);
	/* A scaffold that fails gives the business manager's files back as they
	   were: a second manifest with the same id makes the CLI refuse. */
	const written = await readFile(
		join(paths.modulePath, 'translations/pl.json'),
		'utf8',
	);
	const clash = join(paths.workspace, 'modules/elsewhere/module.json');
	await mkdir(join(paths.workspace, 'modules/elsewhere'), { recursive: true });
	await writeFile(clash, JSON.stringify({ id: 'booking.core' }));
	expect(await scaffoldFromSpec(context, approved.session)).toContain(
		'The module scaffold for booking.core failed',
	);
	expect(
		await readFile(join(paths.modulePath, 'translations/pl.json'), 'utf8'),
	).toBe(written);
	await rm(join(paths.workspace, 'modules/elsewhere'), { recursive: true });
	const result = await scaffoldFromSpec(context, approved.session);
	const manifest = JSON.parse(
		await readFile(join(paths.modulePath, 'module.json'), 'utf8'),
	) as { id: string };
	expect(manifest.id, result ?? '').toBe('booking.core');
	const bundles = Object.fromEntries(
		await Promise.all(
			['en', 'pl'].map(async (locale) => [
				locale,
				JSON.parse(
					await readFile(
						join(paths.modulePath, `translations/${locale}.json`),
						'utf8',
					),
				) as Record<string, string>,
			]),
		),
	) as Record<'en' | 'pl', Record<string, string>>;
	expect(bundles.pl).toMatchObject({
		'business.custom': 'Rezerwacja sali',
		'page.title': 'Rezerwacje sal',
	});
	expect(bundles.en['page.title']).toBe('Room bookings');
	const clientKeys = new Set<string>();
	for (const entry of await readdir(join(paths.modulePath, 'src/client'))) {
		const source = await readFile(
			join(paths.modulePath, 'src/client', entry),
			'utf8',
		);
		for (const match of source.matchAll(/\bt\(\s*'booking\.([\w.-]+)'/g)) {
			if (!match[1]!.endsWith('.')) clientKeys.add(match[1]!);
		}
	}
	expect(clientKeys.size).toBeGreaterThan(0);
	expect(
		[...clientKeys].filter(
			(key) => !(key in bundles.en) && !(`${key}.other` in bundles.en),
		),
	).toEqual([]);
	expect(
		await readFile(join(paths.modulePath, 'src/services/migration.ts'), 'utf8'),
	).toContain('postgresql');
	await expect(
		stat(join(paths.modulePath, 'tests/module.test.ts')),
	).resolves.toBeDefined();
	expect(await scaffoldFromSpec(context, approved.session)).toBeNull();
}, 30_000);
