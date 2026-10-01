import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { planScaffold } from '../src/module-templates.ts';

/* A states block with transitions is a promise the operator approved, and until
   the lifecycle engine existed nothing read it: the scaffold marked the column
   as an enum and the status stayed writable by any update. These tests run the
   code the generator actually emits, so a change that stops producing a working
   guard fails here rather than in a module somebody builds later. */

const SPEC = `schemaVersion: 2
id: claims.core
specVersion: 0.1.0
status: approved
name: Claims Core
description: Lifecycle scaffold fixture.
profile: full
capabilities:
  - api
  - database
dependencies: []
tenancy: required
locales:
  - en
permissions:
  - id: claims.records.read
    description: Read claims.
  - id: claims.records.manage
    description: Manage claims.
  - id: claims.records.decide
    description: Decide claims.
entities:
  - id: claims
    name: Claim
    fields:
      - id: reference
        type: string
        required: true
        unique: tenant
      - id: status
        type: enum
        required: true
        values: [draft, investigation, approved, paid, closed]
    states:
      field: status
      values: [draft, investigation, approved, paid, closed]
      transitions:
        - from: draft
          to: investigation
          permission: claims.records.manage
        - from: investigation
          to: approved
          permission: claims.records.decide
        - from: approved
          to: paid
          permission: claims.records.manage
        - from: paid
          to: closed
screens:
  - id: claims
    kind: list
    entity: claims
    columns: [reference, status]
`;

const directories: string[] = [];
afterAll(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

type LifecycleModule = {
	authorizeStatus: (
		caller: { readonly permissions: ReadonlySet<string> },
		from: string,
		to: string,
	) =>
		| { readonly allowed: true; readonly state: string }
		| {
				readonly allowed: false;
				readonly code: string;
				readonly message: string;
				readonly permission?: string;
		  };
	initialStatus: string;
	isTerminalStatus: (state: string) => boolean;
	claimsTransitionsFrom: (state: string) => readonly {
		readonly to: string;
		readonly permission?: string;
	}[];
	claimsLifecycle: {
		readonly field: string;
		readonly states: readonly string[];
	};
};

async function generate(specText: string): Promise<{
	readonly files: ReadonlyMap<string, string>;
	readonly load: () => Promise<LifecycleModule>;
}> {
	const files = planScaffold(parse(specText), specText);
	/* Written inside the package so the test runner's loader resolves the
	   @flowdular/kernel import the generated file carries. */
	/* The layout mirrors a workspace, because the generated tsconfig extends
	   ../tsconfig.base.json and a module lives under modules/. */
	const workspace = await mkdtemp(
		join(resolve(import.meta.dirname, '..'), 'lifecycle-fixture-'),
	);
	directories.push(workspace);
	const root = join(workspace, 'modules', 'claims');
	/* The generated tsconfig extends the workspace base, which a fixture root has
	   to carry for the runner to transform the generated file at all. */
	await writeFile(
		join(workspace, 'tsconfig.base.json'),
		await readFile(
			resolve(import.meta.dirname, '..', '..', '..', 'tsconfig.base.json'),
			'utf8',
		),
		'utf8',
	);
	for (const [path, body] of files) {
		const target = join(root, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, body, 'utf8');
	}
	return {
		files,
		load: async () =>
			(await import(
				pathToFileURL(join(root, 'src/domain/status-lifecycle.ts')).href
			)) as LifecycleModule,
	};
}

describe('the lifecycle the scaffold generates', () => {
	it('emits a guard only when the specification declares transitions', async () => {
		const withTransitions = await generate(SPEC);
		expect(withTransitions.files.has('src/domain/status-lifecycle.ts')).toBe(
			true,
		);

		const vocabularyOnly = SPEC.replace(
			/      transitions:\n(        - from:.*\n|          to:.*\n|          permission:.*\n)+/,
			'',
		);
		const without = await generate(vocabularyOnly);
		expect(without.files.has('src/domain/status-lifecycle.ts')).toBe(false);
	});

	/* The lifecycle guard imports the kernel. A package.json that does not declare
	   it produces a module that typechecks and then fails the dependencies gate on
	   the file the scaffold emitted, which is exactly what a real build hit. */
	it('declares the kernel the emitted guard imports', async () => {
		const withGuard = await generate(SPEC);
		const manifest = JSON.parse(withGuard.files.get('package.json')!) as {
			dependencies: Record<string, string>;
		};
		expect(withGuard.files.get('src/domain/status-lifecycle.ts')).toContain(
			"from '@flowdular/kernel'",
		);
		expect(manifest.dependencies['@flowdular/kernel']).toBe('workspace:*');

		const vocabularyOnly = SPEC.replace(
			/      transitions:\n(        - from:.*\n|          to:.*\n|          permission:.*\n)+/,
			'',
		);
		const without = await generate(vocabularyOnly);
		const bare = JSON.parse(without.files.get('package.json')!) as {
			dependencies: Record<string, string>;
		};
		expect(bare.dependencies['@flowdular/kernel']).toBeUndefined();
	});

	it('names the field and the states the specification declared', async () => {
		const { load } = await generate(SPEC);
		const lifecycle = (await load()).claimsLifecycle;
		expect(lifecycle.field).toBe('status');
		expect(lifecycle.states).toEqual([
			'draft',
			'investigation',
			'approved',
			'paid',
			'closed',
		]);
	});

	it('uses the module permission constants, not the strings from the spec', async () => {
		const { files } = await generate(SPEC);
		const source = files.get('src/domain/status-lifecycle.ts')!;
		expect(source).toContain('CLAIMS_PERMISSIONS.manage');
		expect(source).toContain('CLAIMS_PERMISSIONS.decide');
		/* A spec id pasted into the guard would drift from the ACL silently. */
		expect(source).not.toContain("permission: 'claims.records.manage'");
	});

	it('allows a declared move the caller is scoped for', async () => {
		const { load } = await generate(SPEC);
		const { authorizeStatus } = await load();
		expect(
			authorizeStatus(
				{ permissions: new Set(['claims.records.manage']) },
				'draft',
				'investigation',
			),
		).toEqual({ allowed: true, state: 'investigation' });
	});

	it('refuses a move the specification never declared', async () => {
		const { load } = await generate(SPEC);
		const { authorizeStatus } = await load();
		const decision = authorizeStatus(
			{ permissions: new Set(['claims.records.manage']) },
			'draft',
			'paid',
		);
		expect(decision.allowed).toBe(false);
		if (decision.allowed) return;
		expect(decision.code).toBe('TRANSITION_NOT_ALLOWED');
		/* The refusal names what was allowed, so a screen can offer the moves. */
		expect(decision.message).toContain('investigation');
	});

	it('refuses a declared move the caller has no scope for', async () => {
		const { load } = await generate(SPEC);
		const { authorizeStatus } = await load();
		const decision = authorizeStatus(
			{ permissions: new Set(['claims.records.read']) },
			'draft',
			'investigation',
		);
		expect(decision.allowed).toBe(false);
		if (decision.allowed) return;
		expect(decision.code).toBe('PERMISSION_REQUIRED');
		expect(decision.permission).toBe('claims.records.manage');
	});

	it('starts a record in the first declared state', async () => {
		const { load } = await generate(SPEC);
		expect((await load()).initialStatus).toBe('draft');
	});

	it('tells a screen which states are finished and what to offer', async () => {
		const { load } = await generate(SPEC);
		const lifecycle = await load();
		expect(lifecycle.isTerminalStatus('closed')).toBe(true);
		expect(lifecycle.isTerminalStatus('draft')).toBe(false);
		expect(lifecycle.claimsTransitionsFrom('draft')).toEqual([
			{ to: 'investigation', permission: 'claims.records.manage' },
		]);
	});
});
