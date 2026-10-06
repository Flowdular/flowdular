/* What a produced module is measured on. These are deterministic reads over
   the source the agent wrote, not a second opinion from a model, so a score
   means the same thing in every run and a regression is attributable.

   Every check is conservative: it fails on positive evidence of the defect, or
   on a required marker that is definitely absent, and it abstains otherwise.
   A check that guesses would make the suite untrustworthy in the direction
   that matters most, because a false failure teaches the reader to ignore it. */

export const CHECK_IDS = [
	'module-manifest',
	'permissions-declared',
	'endpoints-declare-permission',
	'tenant-not-from-request',
	'rls-forced',
	'migrations-mirrored',
	'locales-complete',
	'no-sql-interpolation',
	'entities-are-built',
	'actions-have-endpoints',
	'transitions-guarded',
	'screens-have-views',
	'agent-tools-registered',
	'settings-declared',
	'permissions-specified',
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

export interface CheckContext {
	/* Relative path inside the module, to file text. Binary files are absent. */
	readonly files: ReadonlyMap<string, string>;
	/* The frozen specification the module was built from. */
	readonly spec: string;
}

export interface CheckOutcome {
	readonly id: CheckId;
	readonly passed: boolean;
	readonly detail: string;
	/* On a failure of a delivery-gate check: the module files the fix goes
	   in, where the defect was found or, for something missing, where the
	   reference module keeps it. The module-rules gate sends its repair to the
	   role that may write them. */
	readonly paths?: readonly string[];
}

function uniqueFiles(locations: readonly string[]): string[] {
	return [...new Set(locations.map((location) => location.split(':')[0]!))];
}

/* A headless or integration-only module has no endpoint and no table by
   design, and a module that declares no locale ships no bundle. Scoring those
   as failures would teach a reader to ignore the check, so each one applies
   only when the specification declares the capability. `users.core` and
   `reports.core` declare entities while owning no table of their own, so a
   declared entity is not treated as a declared database. */
function specCapabilities(spec: string): ReadonlySet<string> {
	const start = spec.search(/^capabilities:\s*$/m);
	if (start === -1) return new Set();
	const rest = spec.slice(start);
	const block = rest.slice(rest.indexOf('\n')).split(/^\S/m)[0] ?? '';
	return new Set([...block.matchAll(/^\s*-\s+(\S+)\s*$/gm)].map((m) => m[1]!));
}

function appliesTo(context: CheckContext, capability: string): boolean {
	return specCapabilities(context.spec).has(capability);
}

function notApplicable(id: CheckId, reason: string): CheckOutcome {
	return {
		id,
		passed: true,
		detail: `Not applicable: ${reason}`,
	};
}

function sourceFiles(context: CheckContext): [string, string][] {
	return [...context.files].filter(
		([path]) =>
			(path.endsWith('.ts') || path.endsWith('.tsrx')) &&
			!path.includes('/tests/') &&
			!path.includes('.test.'),
	);
}

function specList(spec: string, section: string): string[] {
	const start = spec.indexOf(`\n${section}:`);
	if (start === -1) return [];
	const rest = spec.slice(start + 1);
	const end = rest.search(/\n[a-zA-Z]/);
	const block = end === -1 ? rest : rest.slice(0, end + 1);
	return [...block.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map(
		(match) => match[1]!,
	);
}

/* Conformance reads the shape of the specification itself rather than a list
   of ids, because these checks are about a promise the operator approved: this
   entity, this action, this transition, this screen, this tool. A section runs
   from its own key to the next line that is not indented under it. */
function specSection(spec: string, section: string): string {
	const start = spec.search(new RegExp(`^${section}:\\s*$`, 'm'));
	if (start === -1) return '';
	const rest = spec.slice(start);
	const firstBreak = rest.indexOf('\n');
	if (firstBreak === -1) return rest;
	const end = rest.slice(firstBreak).search(/^\S/m);
	return end === -1 ? rest : rest.slice(0, firstBreak + end + 1);
}

/* Only the direct children of a section count. An entity list holds `- id:`
   entries whose bodies carry their own `- id:` fields, and reading the whole
   block would report every field as a missing entity. */
function specEntries(spec: string, section: string): string[] {
	const block = specSection(spec, section);
	const indent = /^(\s*)-/m.exec(block)?.[1]?.length;
	if (indent === undefined) return [];
	const pattern = new RegExp(`^\\s{${indent}}-\\s+id:\\s*(\\S+)\\s*$`, 'gm');
	return [...block.matchAll(pattern)].map((match) => match[1]!).filter(Boolean);
}

/* The object literal that follows a call, matched by brace depth so a nested
   object cannot end the scan early. */
function callBody(source: string, index: number): string {
	let depth = 0;
	for (let cursor = index; cursor < source.length; cursor += 1) {
		const character = source[cursor];
		if (character === '{') depth += 1;
		else if (character === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(index, cursor + 1);
		}
	}
	return source.slice(index);
}

function moduleManifest(context: CheckContext): CheckOutcome {
	const manifest = context.files.get('module.json');
	if (!manifest)
		return {
			id: 'module-manifest',
			passed: false,
			detail: 'module.json was never written, so nothing was scaffolded.',
		};
	const id = /^id:\s*(\S+)\s*$/m.exec(context.spec)?.[1];
	const declared = id ? manifest.includes(`"${id}"`) : false;
	return {
		id: 'module-manifest',
		passed: declared,
		detail: declared
			? `module.json declares ${id}.`
			: `module.json does not declare the specified id ${id}.`,
	};
}

function permissionsDeclared(context: CheckContext): CheckOutcome {
	const permissions = specList(context.spec, 'permissions');
	if (permissions.length === 0)
		return {
			id: 'permissions-declared',
			passed: true,
			detail: 'The specification declares no permission.',
		};
	const source = [...context.files.values()].join('\n');
	const missing = permissions.filter((id) => !source.includes(id));
	return {
		id: 'permissions-declared',
		passed: missing.length === 0,
		detail:
			missing.length === 0
				? `All ${permissions.length} specified permissions appear in the module.`
				: `The module never names ${missing.join(', ')}.`,
		...(missing.length > 0 ? { paths: ['src/acl/permissions.ts'] } : {}),
	};
}

function endpointsDeclarePermission(context: CheckContext): CheckOutcome {
	if (!appliesTo(context, 'api'))
		return notApplicable(
			'endpoints-declare-permission',
			'the specification declares no api capability.',
		);
	const offenders: string[] = [];
	let endpoints = 0;
	for (const [path, source] of sourceFiles(context)) {
		for (const match of source.matchAll(/defineEndpoint[^({]*\(/g)) {
			const open = source.indexOf('{', match.index + match[0].length - 1);
			if (open === -1) continue;
			endpoints += 1;
			const body = callBody(source, open);
			if (!/\bpermission\s*:/.test(body))
				offenders.push(`${path}:${source.slice(0, open).split('\n').length}`);
		}
	}
	if (endpoints === 0)
		return {
			id: 'endpoints-declare-permission',
			passed: false,
			detail: 'The module defines no endpoint through defineEndpoint.',
			paths: ['src/api/endpoints.ts'],
		};
	return {
		id: 'endpoints-declare-permission',
		passed: offenders.length === 0,
		detail:
			offenders.length === 0
				? `All ${endpoints} endpoints name a permission.`
				: `Endpoints without a permission: ${offenders.join(', ')}.`,
		...(offenders.length > 0 ? { paths: uniqueFiles(offenders) } : {}),
	};
}

function tenantNotFromRequest(context: CheckContext): CheckOutcome {
	const pattern =
		/\b(?:request|req|input|body|query|params|payload|search)\s*(?:\.|\[['"])\s*tenant(?:Id)?\b/i;
	const offenders: string[] = [];
	for (const [path, source] of sourceFiles(context)) {
		const lines = source.split('\n');
		lines.forEach((line, index) => {
			if (pattern.test(line)) offenders.push(`${path}:${index + 1}`);
		});
	}
	return {
		id: 'tenant-not-from-request',
		passed: offenders.length === 0,
		detail:
			offenders.length === 0
				? 'No tenant identity is read from request input.'
				: `Tenant identity read from request input at ${offenders.join(', ')}.`,
		...(offenders.length > 0 ? { paths: uniqueFiles(offenders) } : {}),
	};
}

function rlsForced(context: CheckContext): CheckOutcome {
	if (!appliesTo(context, 'database'))
		return notApplicable(
			'rls-forced',
			'the specification declares no database capability and no entity.',
		);
	const migrations = [...context.files].filter(
		([path]) => path.includes('migrations/') && path.endsWith('.sql'),
	);
	if (migrations.length === 0)
		return {
			id: 'rls-forced',
			passed: false,
			detail: 'The module ships no migration, so no table is protected.',
			paths: ['migrations/'],
		};
	const sql = migrations.map(([, text]) => text.toUpperCase()).join('\n');
	const missing = [
		['ENABLE ROW LEVEL SECURITY', /ENABLE\s+ROW\s+LEVEL\s+SECURITY/],
		['FORCE ROW LEVEL SECURITY', /FORCE\s+ROW\s+LEVEL\s+SECURITY/],
		['a USING predicate', /\bUSING\s*\(/],
		['a WITH CHECK predicate', /\bWITH\s+CHECK\s*\(/],
	]
		.filter(([, pattern]) => !(pattern as RegExp).test(sql))
		.map(([label]) => label as string);
	return {
		id: 'rls-forced',
		passed: missing.length === 0,
		detail:
			missing.length === 0
				? 'Row-level security is enabled, forced, and carries both predicates.'
				: `The migrations are missing ${missing.join(', ')}.`,
		...(missing.length > 0 ? { paths: migrations.map(([path]) => path) } : {}),
	};
}

function migrationsMirrored(context: CheckContext): CheckOutcome {
	if (!appliesTo(context, 'database'))
		return notApplicable(
			'migrations-mirrored',
			'the specification declares no database capability and no entity.',
		);
	const migrations = [...context.files].filter(
		([path]) => path.includes('migrations/') && path.endsWith('.sql'),
	);
	if (migrations.length === 0)
		return {
			id: 'migrations-mirrored',
			passed: false,
			detail: 'The module ships no migration to mirror.',
			paths: ['migrations/'],
		};
	const source = sourceFiles(context)
		.map(([, text]) => text)
		.join('\n');
	if (!source.includes('databaseMigrations'))
		return {
			id: 'migrations-mirrored',
			passed: false,
			detail: 'No source file declares databaseMigrations.',
			paths: ['src/services/migration.ts'],
		};
	/* Whitespace is the one difference the mirror is allowed to carry, because
	   the formatter owns the TypeScript file and not the .sql one. */
	const flatten = (text: string) => text.replace(/\s+/g, ' ').trim();
	const flatSource = flatten(source);
	const unmirrored = migrations
		.filter(([, text]) => !flatSource.includes(flatten(text)))
		.map(([path]) => path);
	return {
		id: 'migrations-mirrored',
		passed: unmirrored.length === 0,
		detail:
			unmirrored.length === 0
				? `All ${migrations.length} migrations are mirrored in databaseMigrations.`
				: `Not mirrored byte for byte: ${unmirrored.join(', ')}.`,
		...(unmirrored.length > 0 ? { paths: unmirrored } : {}),
	};
}

function localesComplete(context: CheckContext): CheckOutcome {
	if (!appliesTo(context, 'translations'))
		return notApplicable(
			'locales-complete',
			'the specification declares no translations capability.',
		);
	const locales = [
		...(
			context.spec.match(/^locales:\n((?:\s+-\s+\S+\n)+)/m)?.[1] ?? ''
		).matchAll(/-\s+(\S+)/g),
	].map((match) => match[1]!);
	if (locales.length === 0)
		return {
			id: 'locales-complete',
			passed: true,
			detail: 'The specification declares no locale.',
		};
	const bundles = new Map<string, Set<string>>();
	const bundlePaths = new Map<string, string>();
	for (const locale of locales) {
		const entry = [...context.files].find(
			([path]) =>
				/translations?\//.test(path) &&
				new RegExp(`\\b${locale}\\.(ts|json)$`).test(path),
		);
		if (!entry) continue;
		bundlePaths.set(locale, entry[0]);
		bundles.set(
			locale,
			new Set(
				[...entry[1].matchAll(/['"]([\w.-]+)['"]\s*:/g)].map(
					(match) => match[1]!,
				),
			),
		);
	}
	const absent = locales.filter((locale) => !bundles.has(locale));
	if (absent.length > 0)
		return {
			id: 'locales-complete',
			passed: false,
			detail: `No translation bundle for ${absent.join(', ')}.`,
			paths: absent.map((locale) => `translations/${locale}.json`),
		};
	const [reference, ...rest] = [...bundles.entries()];
	const drifted = rest
		.filter(([, keys]) => {
			if (keys.size !== reference![1].size) return true;
			for (const key of reference![1]) if (!keys.has(key)) return true;
			return false;
		})
		.map(([locale]) => locale);
	return {
		id: 'locales-complete',
		passed: drifted.length === 0,
		detail:
			drifted.length === 0
				? `All ${locales.length} locales carry the same keys.`
				: `Key set differs from ${reference![0]} in ${drifted.join(', ')}.`,
		...(drifted.length > 0
			? { paths: drifted.map((locale) => bundlePaths.get(locale)!) }
			: {}),
	};
}

function noSqlInterpolation(context: CheckContext): CheckOutcome {
	const offenders: string[] = [];
	for (const [path, source] of sourceFiles(context)) {
		const lines = source.split('\n');
		lines.forEach((line, index) => {
			/* A value interpolated into a statement, rather than bound to it. The
			   identifier forms a migration builds are allowed nowhere either. */
			if (
				/`[^`]*\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|VALUES)\b[^`]*\$\{/i.test(
					line,
				)
			)
				offenders.push(`${path}:${index + 1}`);
		});
	}
	return {
		id: 'no-sql-interpolation',
		passed: offenders.length === 0,
		detail:
			offenders.length === 0
				? 'No statement interpolates a value instead of binding it.'
				: `Interpolated statements at ${offenders.join(', ')}.`,
		...(offenders.length > 0 ? { paths: uniqueFiles(offenders) } : {}),
	};
}

/* Conformance: what the operator approved against what was built. The checks
   below are the reason a specification can be called a contract rather than a
   prompt. Each fails only on positive evidence that a promised part of the
   domain is absent from the module, and abstains when the specification makes no
   such promise. */

/* An identifier is spelled kebab-case in a specification, camelCase in a
   source file and snake_case in a database. Accepting only the specification's
   spelling would fail a module that named things correctly. */
function mentions(source: string, id: string): boolean {
	if (source.includes(id)) return true;
	const camel = id.replace(/-([a-z0-9])/g, (_, character: string) =>
		character.toUpperCase(),
	);
	const snake = id.replace(/-/g, '_');
	const pascal = camel.charAt(0).toUpperCase() + camel.slice(1);
	return (
		source.includes(camel) || source.includes(snake) || source.includes(pascal)
	);
}

/* An entity is a promise the operator read and approved. The cheapest way to
   forget one is to scaffold the first entity and never come back for the rest,
   which is exactly what the scaffold used to do.

   This deliberately does not try to match a table name to an entity id. The
   shipped modules own no consistent relation between the two:
   notifications.core calls `member-preference` a `notifications_preferences`
   table and search.core declares a `provider` entity it keeps in code. What can
   be checked without false alarms is whether the entity exists at all. */
function entitiesAreBuilt(context: CheckContext): CheckOutcome {
	const entities = specEntries(context.spec, 'entities');
	if (entities.length === 0)
		return notApplicable(
			'entities-are-built',
			'the specification declares no entity.',
		);
	const source = [...context.files.values()].join('\n');
	const missing = entities.filter((entity) => !mentions(source, entity));
	return {
		id: 'entities-are-built',
		passed: missing.length === 0,
		detail:
			missing.length === 0
				? `All ${entities.length} specified entities are built: ${entities.join(', ')}.`
				: `The specification declares ${entities.length} entities and the module never mentions ${missing.join(', ')}. Build each declared entity, not only the first.`,
	};
}

/* An action is an operation someone can perform. The module has to name it, or
   the permission the operator approved is granted and never exercised. */
function actionsHaveEndpoints(context: CheckContext): CheckOutcome {
	const actions = specEntries(context.spec, 'actions');
	if (actions.length === 0)
		return notApplicable(
			'actions-have-endpoints',
			'the specification declares no action.',
		);
	const source = [...context.files.values()].join('\n');
	const missing = actions.filter((action) => !mentions(source, action));
	return {
		id: 'actions-have-endpoints',
		passed: missing.length === 0,
		detail:
			missing.length === 0
				? `All ${actions.length} specified actions appear in the module.`
				: `The module never names the action ${missing.join(', ')}.`,
	};
}

/* A declared lifecycle is a promise about the states a record may hold. The
   reliably checkable part is that the vocabulary exists at all: if a state the
   operator read never appears in the module, the lifecycle was not built.

   Whether each transition is *guarded* is deliberately not asserted here. A
   static read cannot tell a service method from a helper, and the four shipped
   modules with lifecycles (audit, documents, import, users) each enforce theirs
   differently, so a rule that named one shape would fail the platform's own
   code. A gate that cries wolf on production modules is worse than none. */
function transitionsGuarded(context: CheckContext): CheckOutcome {
	const froms = [
		...specSection(context.spec, 'entities').matchAll(
			/^\s*-\s+from:\s*(\S+)\s*$/gm,
		),
	].map((match) => match[1]!);
	if (froms.length === 0)
		return notApplicable(
			'transitions-guarded',
			'the specification declares no lifecycle transition.',
		);
	const source = [...context.files.values()].join('\n');
	const unknown = froms.filter((from) => !mentions(source, from));
	const states = [
		...new Set(
			[
				...specSection(context.spec, 'entities').matchAll(
					/^\s*values:\s*\[([^\]]*)\]/gm,
				),
			].flatMap((match) =>
				(match[1] ?? '')
					.split(',')
					.map((value) => value.trim())
					.filter(Boolean),
			),
		),
	];
	const unbuilt = states.filter((state) => !mentions(source, state));
	if (unbuilt.length > 0)
		return {
			id: 'transitions-guarded',
			passed: false,
			detail: `The specification declares the lifecycle ${states.join(' -> ')} and the module never mentions ${unbuilt.join(', ')}. Build every declared state, not only the first.`,
			paths: ['src/domain/types.ts'],
		};
	return {
		id: 'transitions-guarded',
		passed: true,
		detail: `The module implements all ${states.length} declared lifecycle state(s) over ${froms.length} transition(s).`,
	};
}

/* A screen is what a person looks at. A declared screen with no view is a
   capability the operator was told exists and cannot reach. */
function screensHaveViews(context: CheckContext): CheckOutcome {
	const screens = specEntries(context.spec, 'screens');
	if (screens.length === 0)
		return notApplicable(
			'screens-have-views',
			'the specification declares no screen.',
		);
	const views = [...context.files.keys()].filter(
		(path) => path.endsWith('.tsrx') && path.includes('client'),
	);
	const source = [...context.files.values()].join('\n');
	if (views.length === 0)
		return {
			id: 'screens-have-views',
			passed: false,
			detail: `The specification declares ${screens.length} screen(s) (${screens.join(', ')}) and the module ships no client view.`,
		};
	const missing = screens.filter((screen) => !mentions(source, screen));
	return {
		id: 'screens-have-views',
		passed: missing.length === 0,
		detail:
			missing.length === 0
				? `The module has a client view for every specified screen.`
				: `No client view mentions ${missing.join(', ')}.`,
	};
}

function agentToolsRegistered(context: CheckContext): CheckOutcome {
	const tools = specEntries(context.spec, 'agentTools');
	if (tools.length === 0)
		return notApplicable(
			'agent-tools-registered',
			'the specification declares no agent tool.',
		);
	const source = [...context.files.values()].join('\n');
	const missing = tools.filter((tool) => !mentions(source, tool));
	return {
		id: 'agent-tools-registered',
		passed: missing.length === 0,
		detail:
			missing.length === 0
				? `All ${tools.length} specified agent tools appear in the module.`
				: `The module never registers ${missing.join(', ')}.`,
		...(missing.length > 0 ? { paths: ['src/agent/tools.ts'] } : {}),
	};
}

function settingsDeclared(context: CheckContext): CheckOutcome {
	const section = specSection(context.spec, 'settings');
	const keys = [...section.matchAll(/^\s*-\s+key:\s*(\S+)\s*$/gm)].map(
		(match) => match[1]!,
	);
	if (keys.length === 0)
		return notApplicable(
			'settings-declared',
			'the specification declares no setting.',
		);
	const source = [...context.files.values()].join('\n');
	const missing = keys.filter((key) => !mentions(source, key));
	return {
		id: 'settings-declared',
		passed: missing.length === 0,
		detail:
			missing.length === 0
				? `All ${keys.length} specified settings appear in the module.`
				: `The module never declares ${missing.join(', ')}.`,
		...(missing.length > 0 ? { paths: ['src/platform.ts'] } : {}),
	};
}

const PERMISSION_LITERAL = /['"]([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)['"]/g;
const PERMISSION_PROPERTY =
	/\bpermission\s*:\s*['"]([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)['"]/g;

/* The reverse of permissions-declared: a permission the module defines that
   the specification does not list is one the operator never approved. Only the
   module's own permission constants are read, src/acl/permissions.ts where the
   scaffold writes them and a literal `permission:` value, so a translation key
   or a data class id elsewhere is never taken for a permission. */
function permissionsSpecified(context: CheckContext): CheckOutcome {
	const defined = new Set<string>();
	const constants = context.files.get('src/acl/permissions.ts') ?? '';
	for (const match of constants.matchAll(PERMISSION_LITERAL))
		defined.add(match[1]!);
	for (const [, source] of sourceFiles(context)) {
		for (const match of source.matchAll(PERMISSION_PROPERTY))
			defined.add(match[1]!);
	}
	if (defined.size === 0)
		return notApplicable(
			'permissions-specified',
			'the module defines no permission constant.',
		);
	const specified = new Set(specList(context.spec, 'permissions'));
	const unspecified = [...defined].filter((id) => !specified.has(id)).sort();
	return {
		id: 'permissions-specified',
		passed: unspecified.length === 0,
		detail:
			unspecified.length === 0
				? `Every permission the module defines is in the specification.`
				: `The module defines ${unspecified.join(', ')}, which the approved specification does not list. Ask for a new permission with a questions block instead of adding it.`,
		...(unspecified.length > 0 ? { paths: ['src/acl/permissions.ts'] } : {}),
	};
}

const CHECKS: Record<CheckId, (context: CheckContext) => CheckOutcome> = {
	'module-manifest': moduleManifest,
	'permissions-declared': permissionsDeclared,
	'endpoints-declare-permission': endpointsDeclarePermission,
	'tenant-not-from-request': tenantNotFromRequest,
	'rls-forced': rlsForced,
	'migrations-mirrored': migrationsMirrored,
	'locales-complete': localesComplete,
	'no-sql-interpolation': noSqlInterpolation,
	'entities-are-built': entitiesAreBuilt,
	'actions-have-endpoints': actionsHaveEndpoints,
	'transitions-guarded': transitionsGuarded,
	'screens-have-views': screensHaveViews,
	'agent-tools-registered': agentToolsRegistered,
	'settings-declared': settingsDeclared,
	'permissions-specified': permissionsSpecified,
};

/* The specification is not part of the module. Reading spec/module.yaml into the
   same map as the sources made every declared id "appear in the module" by
   being in the contract that asked for it, which silently voided the
   conformance checks that look for a name in the source. */
function withoutSpecification(files: ReadonlyMap<string, string>) {
	const filtered = new Map<string, string>();
	for (const [path, text] of files) {
		if (path === 'spec/module.yaml' || path.endsWith('/spec/module.yaml'))
			continue;
		filtered.set(path, text);
	}
	return filtered;
}

/* Conformance needs the specification and the code to share identifiers, and
   today they only partly do. Four checks are safe as hard gates because their
   ids are code identifiers: an agent tool's id is its registry key, a setting's
   key is its settings key, a lifecycle value is a value in a union type, and a
   permission id is the string its constant holds.
   The rest compare a kebab-case specification id against whatever the
   implementer chose to call the thing, and the shipped modules show how far
   apart those can be: connectors.core calls its `audit-entry` entity a
   `connectors_audit` table, users.core names no symbol `new-member`, and
   auth.core routes no endpoint called `update-provider`. Those stay scored by
   the evaluation suite, where a miss is information, and out of the delivery
   gate, where a miss would fail a correct module. */
export const CONFORMANCE_CHECKS = [
	'transitions-guarded',
	'agent-tools-registered',
	'settings-declared',
	'permissions-specified',
] as const;

export const PROVISIONAL_CHECKS = [
	'entities-are-built',
	'actions-have-endpoints',
	'screens-have-views',
] as const;

export function runChecks(
	ids: readonly CheckId[],
	context: CheckContext,
): readonly CheckOutcome[] {
	const measured: CheckContext = {
		files: withoutSpecification(context.files),
		spec: context.spec,
	};
	return ids.map((id) => CHECKS[id](measured));
}
