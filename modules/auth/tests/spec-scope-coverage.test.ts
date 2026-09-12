import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { MEMBER_SCOPES, OWNER_SCOPES } from '../src/acl/scopes.ts';

/* acl/scopes.ts is what a workspace is seeded from: signUp writes OWNER_SCOPES
   and MEMBER_SCOPES into the two built-in role rows and into the founding
   membership. auth sync-scopes grants a module's declared permissions when the
   module is enabled, but only to the workspaces that exist at that moment, so a
   permission missing from these lists is missing for ever from every workspace
   created afterwards. Nothing else compares the two, which is how
   audit.holds.manage reached a release declared by audit.core and held by
   nobody. This reads the enabled modules of flowdular.json and their
   specifications, which are the declarations themselves. */

interface ModuleSpec {
	readonly id?: string;
	readonly permissions?: readonly { readonly id?: string }[];
	readonly decisions?: readonly {
		readonly id?: string;
		readonly answer?: string;
	}[];
}

interface EnabledModule {
	readonly moduleId: string;
	readonly spec: ModuleSpec;
	readonly permissions: readonly string[];
}

/**
 * Permission ids an enabled module declares that OWNER_SCOPES does not carry.
 * Owners hold every permission an enabled module declares, so the list is
 * empty and the assertion below is what keeps it that way. A gap has the same
 * consequence every time: a workspace created after the module was enabled
 * never receives the permission, because the seed lists are the only path that
 * reaches a new workspace. Closing one also needs a backfill migration for the
 * workspaces that already exist, so a permission is named here only while that
 * delivery is still open, and the assertion is an equality, so naming one and
 * leaving one unnamed fail alike.
 */
const OWNER_COVERAGE_GAP: readonly string[] = [];

/* "members hold", "member holds", "Every member holds". Not "a member holding
   X", which states what an action needs rather than what a role is given. */
const MEMBERS_HOLD = /\bmembers?\s+holds?\b/i;
/* What follows "members hold" when the answer grants them none of it. */
const MEMBERS_HOLD_NOTHING = /^\s*(?:neither|none|nothing|no\b)/i;
const PERMISSION_DECISION = /-PERMISSIONS?$/;

/**
 * The repository this module is checked out in. A sandbox session copies the
 * module into a workspace of its own that carries neither flowdular.json nor
 * the other modules, and there is nothing to compare there; in the repository
 * the root is always found and every case below runs.
 */
function repositoryRoot(): string | undefined {
	let directory = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 8; depth += 1) {
		if (
			existsSync(join(directory, 'flowdular.json')) &&
			existsSync(join(directory, 'modules'))
		) {
			return directory;
		}
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
	return undefined;
}

const root = repositoryRoot();

function enabledModules(workspaceRoot: string): readonly EnabledModule[] {
	const enabled = new Set(
		(
			JSON.parse(
				readFileSync(join(workspaceRoot, 'flowdular.json'), 'utf8'),
			) as { modules?: { enabled?: readonly string[] } }
		).modules?.enabled ?? [],
	);
	const found: EnabledModule[] = [];
	for (const entry of readdirSync(join(workspaceRoot, 'modules'))) {
		const path = join(workspaceRoot, 'modules', entry, 'spec/module.yaml');
		if (!existsSync(path)) continue;
		const spec = parseYaml(readFileSync(path, 'utf8')) as ModuleSpec;
		if (typeof spec.id !== 'string' || !enabled.has(spec.id)) continue;
		found.push({
			moduleId: spec.id,
			spec,
			permissions: (spec.permissions ?? [])
				.map((permission) => permission.id)
				.filter((id): id is string => typeof id === 'string'),
		});
	}
	return found;
}

/** The module's own permission ids named in one piece of decision prose. */
function named(
	text: string,
	permissions: readonly string[],
): readonly string[] {
	return permissions.filter((permission) => text.includes(permission));
}

describe.skipIf(root === undefined)('declared permission coverage', () => {
	const modules = enabledModules(root ?? '');

	it('reads every enabled module specification', () => {
		const enabled = (
			JSON.parse(readFileSync(join(root ?? '', 'flowdular.json'), 'utf8')) as {
				modules: { enabled: readonly string[] };
			}
		).modules.enabled;

		expect(modules.map((module) => module.moduleId).sort()).toEqual(
			[...enabled].sort(),
		);
		expect(
			modules.flatMap((module) => module.permissions).length,
		).toBeGreaterThan(40);
	});

	it('carries every declared permission of every enabled module in OWNER_SCOPES', () => {
		const held = new Set<string>(OWNER_SCOPES);
		const missing = modules
			.flatMap((module) => module.permissions)
			.filter((permission) => !held.has(permission))
			.sort();

		expect(missing).toEqual([...OWNER_COVERAGE_GAP].sort());
	});

	it('grants members exactly what a permissions decision says they hold', () => {
		const held = new Set<string>(MEMBER_SCOPES);
		const checked: string[] = [];
		for (const module of modules) {
			for (const decision of module.spec.decisions ?? []) {
				const answer = decision.answer;
				if (
					typeof decision.id !== 'string' ||
					!PERMISSION_DECISION.test(decision.id) ||
					typeof answer !== 'string'
				) {
					continue;
				}
				const match = MEMBERS_HOLD.exec(answer);
				if (!match) continue;
				const before = answer.slice(0, match.index);
				const after = answer.slice(match.index + match[0].length);
				if (MEMBERS_HOLD_NOTHING.test(after)) {
					/* "Owners hold A and B; members hold neither" withholds the ids the
					   owners clause named, which is what "neither" points back at. */
					const withheld = named(before, module.permissions);
					expect(withheld.length).toBeGreaterThan(0);
					expect(withheld.filter((permission) => held.has(permission))).toEqual(
						[],
					);
					checked.push(decision.id);
					continue;
				}
				/* An answer that names no id after the phrase ("members hold read")
				   says nothing this can check; it is left alone rather than guessed. */
				const granted = named(after, module.permissions);
				if (granted.length === 0) continue;
				expect(granted.filter((permission) => !held.has(permission))).toEqual(
					[],
				);
				checked.push(decision.id);
			}
		}

		/* A wording the parse stops recognising would make every assertion above
		   vacuous, so the run has to have reached the decisions it is here for. */
		expect(checked).toContain('D-AUDIT-PERMISSIONS');
		expect(checked).toContain('D-APPROVALS-PERMISSIONS');
		expect(checked.length).toBeGreaterThanOrEqual(8);
	});
});
