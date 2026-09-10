import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
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

it('creates a real module through the checkout CLI only after approval, preserving business-manager files', async () => {
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
		join(paths.modulePath, 'translations/pl.json'),
		'{"business.custom":"Rezerwacja sali"}\n',
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
	const result = await scaffoldFromSpec(context, approved.session);
	const manifest = JSON.parse(
		await readFile(join(paths.modulePath, 'module.json'), 'utf8'),
	) as { id: string };
	expect(manifest.id, result ?? '').toBe('booking.core');
	expect(
		await readFile(join(paths.modulePath, 'translations/pl.json'), 'utf8'),
	).toContain('Rezerwacja sali');
	expect(
		await readFile(join(paths.modulePath, 'src/services/migration.ts'), 'utf8'),
	).toContain('postgresql');
	await expect(
		stat(join(paths.modulePath, 'tests/module.test.ts')),
	).resolves.toBeDefined();
	expect(await scaffoldFromSpec(context, approved.session)).toBeNull();
}, 30_000);
