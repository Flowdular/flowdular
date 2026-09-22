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
	};
}

function endpointsDeclarePermission(context: CheckContext): CheckOutcome {
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
		};
	return {
		id: 'endpoints-declare-permission',
		passed: offenders.length === 0,
		detail:
			offenders.length === 0
				? `All ${endpoints} endpoints name a permission.`
				: `Endpoints without a permission: ${offenders.join(', ')}.`,
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
	};
}

function rlsForced(context: CheckContext): CheckOutcome {
	const migrations = [...context.files].filter(
		([path]) => path.includes('migrations/') && path.endsWith('.sql'),
	);
	if (migrations.length === 0)
		return {
			id: 'rls-forced',
			passed: false,
			detail: 'The module ships no migration, so no table is protected.',
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
	};
}

function migrationsMirrored(context: CheckContext): CheckOutcome {
	const migrations = [...context.files].filter(
		([path]) => path.includes('migrations/') && path.endsWith('.sql'),
	);
	if (migrations.length === 0)
		return {
			id: 'migrations-mirrored',
			passed: false,
			detail: 'The module ships no migration to mirror.',
		};
	const source = sourceFiles(context)
		.map(([, text]) => text)
		.join('\n');
	if (!source.includes('databaseMigrations'))
		return {
			id: 'migrations-mirrored',
			passed: false,
			detail: 'No source file declares databaseMigrations.',
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
	};
}

function localesComplete(context: CheckContext): CheckOutcome {
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
	for (const locale of locales) {
		const entry = [...context.files].find(
			([path]) =>
				/translations?\//.test(path) &&
				new RegExp(`\\b${locale}\\.(ts|json)$`).test(path),
		);
		if (!entry) continue;
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
};

export function runChecks(
	ids: readonly CheckId[],
	context: CheckContext,
): readonly CheckOutcome[] {
	return ids.map((id) => CHECKS[id](context));
}
