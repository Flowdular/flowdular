import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import Ajv2020, {
	type ErrorObject,
	type ValidateFunction,
} from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import {
	blueprintSchema,
	cliExtensionSchema,
	moduleSchema,
	moduleCatalogSchema,
	moduleArtifactSchema,
	moduleSpecSchema,
	platformSpecSchema,
	projectSchema,
	type ModuleSpec,
	type ValidationIssue,
} from '@flowdular/contracts';
import {
	OWNED_SCREEN_COLUMNS,
	reservedFieldReason,
} from './module-templates.ts';

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = {
	application: ajv.compile(projectSchema.properties.application),
	web: ajv.compile(projectSchema.properties.web),
	project: ajv.compile(projectSchema),
	module: ajv.compile(moduleSchema),
	moduleCatalog: ajv.compile(moduleCatalogSchema),
	moduleArtifact: ajv.compile(moduleArtifactSchema),
	moduleSpec: ajv.compile(moduleSpecSchema),
	blueprint: ajv.compile(blueprintSchema),
	cliExtension: ajv.compile(cliExtensionSchema),
	platformSpec: ajv.compile(platformSpecSchema),
};

export interface FileValidation {
	readonly file: string;
	readonly valid: boolean;
	readonly issues: readonly ValidationIssue[];
}

function issuesFrom(
	errors: ErrorObject[] | null | undefined,
): ValidationIssue[] {
	return (errors ?? []).map((error) => ({
		/* Ajv reports a rejected branch as the keyword "false schema". */
		code: `SCHEMA_${error.keyword.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
		message: error.message ?? 'Schema validation failed.',
		path: error.instancePath || '/',
		severity: 'error' as const,
	}));
}

function specIssue(
	code: string,
	message: string,
	path: string,
): ValidationIssue {
	return { code, message, path, severity: 'error' };
}

/**
 * Screen kinds a client renders on its own. A form is a drawer inside one of
 * these, so it is not what a workspace view is built from.
 */
const RENDERABLE_SCREEN_KINDS = new Set(['list', 'record', 'dashboard']);

function duplicateIssues<T>(
	items: readonly T[] | undefined,
	key: keyof T & string,
	section: string,
): ValidationIssue[] {
	const seen = new Set<string>();
	const issues: ValidationIssue[] = [];
	(items ?? []).forEach((item, index) => {
		const id = item[key];
		if (typeof id !== 'string') return;
		if (seen.has(id)) {
			issues.push(
				specIssue(
					'SPEC_DUPLICATE_ID',
					`${section} declares "${id}" more than once.`,
					`/${section}/${index}/${key}`,
				),
			);
		}
		seen.add(id);
	});
	return issues;
}

const MONTH_NAMES = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(
	' ',
);
const WEEKDAY_NAMES = 'sun mon tue wed thu fri sat'.split(' ');
const CRON_FIELDS = [
	{ name: 'minute', min: 0, max: 59 },
	{ name: 'hour', min: 0, max: 23 },
	{ name: 'day of month', min: 1, max: 31 },
	{ name: 'month', min: 1, max: 12, names: MONTH_NAMES },
	{ name: 'day of week', min: 0, max: 7, names: WEEKDAY_NAMES },
] as const;

/* Mirrors the `cron:` cadence grammar of modules/automations/src/domain/cron.ts,
   so a declared schedule is never refused once it is saved as a schedule.
   Answers what is wrong, or undefined. */
function cronIssue(expression: string): string | undefined {
	const fields = expression.split(' ');
	if (fields.length !== 5) return 'it needs five fields';
	for (const [index, field] of fields.entries()) {
		const spec = CRON_FIELDS[index]!;
		const names: readonly string[] = 'names' in spec ? spec.names : [];
		const value = (raw: string): number | undefined => {
			const named = names.indexOf(raw);
			if (named >= 0) return named + spec.min;
			const number = /^\d{1,2}$/.test(raw) ? Number(raw) : Number.NaN;
			return number >= spec.min && number <= spec.max ? number : undefined;
		};
		const items = field.split(',');
		if (items.length > 32) return `${spec.name} lists too many values`;
		for (const item of items) {
			const [base = '', step, extra] = item.split('/');
			if (extra !== undefined || base === '')
				return `${spec.name} has an unsupported value`;
			if (
				step !== undefined &&
				(!/^\d{1,2}$/.test(step) ||
					Number(step) < 1 ||
					Number(step) > spec.max - spec.min + 1)
			)
				return `${spec.name} has an unsupported step`;
			if (base === '*') continue;
			const bounds = base.split('-');
			if (bounds.length > 2) return `${spec.name} has an unsupported range`;
			const from = value(bounds[0]!);
			const to = bounds.length === 2 ? value(bounds[1]!) : from;
			if (from === undefined || to === undefined)
				return `${spec.name} must be between ${spec.min} and ${spec.max}`;
			if (bounds.length === 1 && step !== undefined)
				return `${spec.name} needs a range or * before a step`;
			if (to < from) return `${spec.name} range runs backwards`;
		}
	}
	return undefined;
}

/* Cross-document checks the JSON schema cannot express. A version 1 document
   carries none of the referenced sections, so it is never inspected. */
export function moduleSpecIssues(value: unknown): ValidationIssue[] {
	const spec = value as ModuleSpec;
	if (!spec || typeof spec !== 'object' || spec.schemaVersion !== 2) return [];

	const entities = spec.entities ?? [];
	const fieldsByEntity = new Map<string, ReadonlySet<string>>(
		entities.map((entity) => [
			entity.id,
			new Set((entity.fields ?? []).map((field) => field.id)),
		]),
	);
	const permissions = new Set((spec.permissions ?? []).map((item) => item.id));
	const modules = new Set([
		spec.id,
		...(spec.dependencies ?? []).map((dependency) => dependency.id),
	]);
	const capabilities = new Set(spec.capabilities ?? []);

	const issues: ValidationIssue[] = [
		...duplicateIssues(entities, 'id', 'entities'),
		...duplicateIssues(spec.screens, 'id', 'screens'),
		...duplicateIssues(spec.actions, 'id', 'actions'),
		...duplicateIssues(spec.widgets, 'id', 'widgets'),
		...duplicateIssues(spec.settings, 'key', 'settings'),
		...duplicateIssues(spec.agentTools, 'id', 'agentTools'),
		...duplicateIssues(spec.decisions, 'id', 'decisions'),
		...duplicateIssues(spec.adapters, 'id', 'adapters'),
		...duplicateIssues(spec.templates, 'id', 'templates'),
	];

	if (capabilities.has('database') && entities.length === 0) {
		issues.push(
			specIssue(
				'SPEC_ENTITY_REQUIRED',
				'A specification with the database capability must declare at least one entity.',
				'/entities',
			),
		);
	}

	entities.forEach((entity, index) => {
		issues.push(
			...duplicateIssues(entity.fields, 'id', `entities/${index}/fields`),
		);
		const statePath = `/entities/${index}/states/field`;
		const stateField = (entity.fields ?? []).find(
			(field) => field.id === entity.states?.field,
		);
		if (entity.states && !stateField) {
			issues.push(
				specIssue(
					'SPEC_FIELD_UNKNOWN',
					`"${entity.states.field}" is not a field of entity "${entity.id}".`,
					statePath,
				),
			);
		}
		/* The service writes the first lifecycle value into the column, so the
		   field has to be the enum that declares exactly those values. */
		if (entity.states && stateField && stateField.type !== 'enum') {
			issues.push(
				specIssue(
					'SPEC_STATE_FIELD_INVALID',
					`Lifecycle field "${entity.id}.${stateField.id}" is a ${stateField.type} field; a lifecycle field must be an enum.`,
					statePath,
				),
			);
		}
		if (
			entity.states &&
			stateField?.type === 'enum' &&
			(stateField.values ?? []).join('\u0000') !==
				entity.states.values.join('\u0000')
		) {
			issues.push(
				specIssue(
					'SPEC_STATE_FIELD_INVALID',
					`Lifecycle values of "${entity.id}" differ from the values of enum field "${stateField.id}".`,
					`/entities/${index}/states/values`,
				),
			);
		}
		(entity.fields ?? []).forEach((field, fieldIndex) => {
			const path = `/entities/${index}/fields/${fieldIndex}`;
			const reserved = reservedFieldReason(field.id);
			if (reserved) {
				issues.push(
					specIssue(
						'SPEC_FIELD_RESERVED',
						`Field "${entity.id}.${field.id}" ${reserved}.`,
						`${path}/id`,
					),
				);
			}
			if (field.type === 'enum' && (field.values ?? []).length === 0) {
				issues.push(
					specIssue(
						'SPEC_ENUM_VALUES_REQUIRED',
						`Enum field "${entity.id}.${field.id}" declares no values.`,
						`${path}/values`,
					),
				);
			}
			if (field.type !== 'reference') return;
			const target = field.reference ?? '';
			const segments = target.split('.');
			const owner = segments.slice(0, -1).join('.');
			/* A reference into this specification names a local entity however it
			   is spelled, so the qualified form resolves against the same set. */
			const known =
				segments.length === 1 || owner === spec.id
					? fieldsByEntity.has(segments[segments.length - 1] ?? '')
					: modules.has(owner);
			if (!known) {
				issues.push(
					specIssue(
						'SPEC_REFERENCE_UNKNOWN',
						`Reference field "${entity.id}.${field.id}" points at "${target}", which is neither an entity of this specification nor an entity of a declared dependency.`,
						`${path}/reference`,
					),
				);
			}
		});
		if (
			capabilities.has('database') &&
			!(entity.fields ?? []).some((field) => field.unique === 'tenant')
		) {
			issues.push({
				code: 'SPEC_ENTITY_UNIQUE_MISSING',
				message: `Entity "${entity.id}" declares no field unique inside a tenant.`,
				path: `/entities/${index}`,
				severity: 'warning',
			});
		}
	});

	const entityIssue = (
		entity: string | undefined,
		path: string,
		key = 'entity',
	): ValidationIssue | undefined => {
		if (entity === undefined || fieldsByEntity.has(entity)) return undefined;
		return specIssue(
			'SPEC_ENTITY_UNKNOWN',
			`"${entity}" is not an entity of this specification.`,
			`${path}/${key}`,
		);
	};

	(spec.screens ?? []).forEach((screen, index) => {
		const path = `/screens/${index}`;
		const unknownEntity = entityIssue(screen.entity, path);
		if (unknownEntity) issues.push(unknownEntity);
		const fields = screen.entity
			? fieldsByEntity.get(screen.entity)
			: undefined;
		for (const key of ['columns', 'filters'] as const) {
			const names = screen[key] ?? [];
			if (names.length === 0) continue;
			if (!fields) {
				if (!unknownEntity) {
					issues.push(
						specIssue(
							'SPEC_ENTITY_UNKNOWN',
							`Screen "${screen.id}" lists ${key} but names no entity.`,
							`${path}/entity`,
						),
					);
				}
				continue;
			}
			names.forEach((name, nameIndex) => {
				if (fields.has(name) || OWNED_SCREEN_COLUMNS.has(name)) return;
				issues.push(
					specIssue(
						'SPEC_FIELD_UNKNOWN',
						`"${name}" is not a field of entity "${screen.entity}".`,
						`${path}/${key}/${nameIndex}`,
					),
				);
			});
		}
	});

	(spec.actions ?? []).forEach((action, index) => {
		const path = `/actions/${index}`;
		const unknownEntity = entityIssue(action.entity, path);
		if (unknownEntity) issues.push(unknownEntity);
		if (!permissions.has(action.permission)) {
			issues.push(
				specIssue(
					'SPEC_ACTION_PERMISSION_UNKNOWN',
					`Action "${action.id}" requires permission "${action.permission}", which the specification does not declare.`,
					`${path}/permission`,
				),
			);
		}
	});

	(spec.widgets ?? []).forEach((widget, index) => {
		const unknownEntity = entityIssue(widget.entity, `/widgets/${index}`);
		if (unknownEntity) issues.push(unknownEntity);
	});

	(spec.settings ?? []).forEach((setting, index) => {
		if (setting.type === 'enum' && (setting.values ?? []).length === 0) {
			issues.push(
				specIssue(
					'SPEC_ENUM_VALUES_REQUIRED',
					`Enum setting "${setting.key}" declares no values.`,
					`/settings/${index}/values`,
				),
			);
		}
		if (setting.kind !== 'flag') return;
		/* A flag is on or off for one workspace, so the runtime accepts nothing
		   else: `defineModuleSettings` refuses another type or scope, and a flag
		   without a default has no state to fall back to. */
		if (setting.type !== 'boolean') {
			issues.push(
				specIssue(
					'SPEC_FLAG_TYPE_INVALID',
					`Feature flag "${setting.key}" is ${setting.type}; a flag is boolean.`,
					`/settings/${index}/type`,
				),
			);
		}
		if (setting.scope !== 'tenant') {
			issues.push(
				specIssue(
					'SPEC_FLAG_SCOPE_INVALID',
					`Feature flag "${setting.key}" is ${setting.scope} scoped; a flag is set per workspace.`,
					`/settings/${index}/scope`,
				),
			);
		}
		if (setting.default === undefined) {
			issues.push(
				specIssue(
					'SPEC_FLAG_DEFAULT_REQUIRED',
					`Feature flag "${setting.key}" declares no default; say whether it starts on or off.`,
					`/settings/${index}/default`,
				),
			);
		}
	});

	const evidenceOwner = entityIssue(
		spec.research?.evidenceOwner,
		'/research',
		'evidenceOwner',
	);
	if (evidenceOwner) issues.push(evidenceOwner);

	(spec.templates ?? []).forEach((template, index) => {
		const unknownEntity = entityIssue(
			template.inputEntity,
			`/templates/${index}`,
			'inputEntity',
		);
		if (unknownEntity) issues.push(unknownEntity);
	});

	(spec.adapters ?? []).forEach((adapter, index) => {
		const path = `/adapters/${index}`;
		if (!adapter.id.startsWith(`${spec.id}.`)) {
			issues.push(
				specIssue(
					'SPEC_ADAPTER_ID_NAMESPACE',
					`Adapter "${adapter.id}" must start with the module id "${spec.id}.".`,
					`${path}/id`,
				),
			);
		}
		/* An import port id is "<moduleId>.<key>", and a port is registered by
		   the module that owns the records, so it must be this module or one it
		   declares as a dependency. */
		if (
			adapter.direction === 'source' &&
			![...modules].some((owner) => adapter.port.startsWith(`${owner}.`))
		) {
			issues.push(
				specIssue(
					'SPEC_ADAPTER_PORT_UNKNOWN',
					`Source adapter "${adapter.id}" writes through port "${adapter.port}", which belongs neither to this module nor to a declared dependency.`,
					`${path}/port`,
				),
			);
		}
		const schedule =
			typeof adapter.schedule === 'string'
				? cronIssue(adapter.schedule)
				: undefined;
		if (schedule) {
			issues.push(
				specIssue(
					'SPEC_ADAPTER_SCHEDULE_INVALID',
					`Schedule of adapter "${adapter.id}" is not a five-field cron: ${schedule}.`,
					`${path}/schedule`,
				),
			);
		}
		adapter.mapping.forEach((entry, entryIndex) => {
			const missing =
				entry.transform !== 'constant' && entry.from === undefined
					? 'from'
					: entry.transform !== 'rename' && typeof entry.value !== 'string'
						? 'value'
						: undefined;
			if (!missing) return;
			issues.push(
				specIssue(
					'SPEC_ADAPTER_MAPPING_INVALID',
					`A ${entry.transform} mapping of adapter "${adapter.id}" needs "${missing}".`,
					`${path}/mapping/${entryIndex}/${missing}`,
				),
			);
		});
	});

	/* The scaffold builds the workspace view from a screen the client renders
	   on its own, so a client that declares none has nothing to render. */
	if (
		capabilities.has('client') &&
		!(spec.screens ?? []).some((screen) =>
			RENDERABLE_SCREEN_KINDS.has(screen.kind),
		)
	) {
		issues.push({
			code: 'SPEC_SCREENS_MISSING',
			message:
				'A specification with the client capability declares no screen to render.',
			path: '/screens',
			severity: 'warning',
		});
	}

	return issues;
}

async function parseFile(path: string): Promise<unknown> {
	const source = await readFile(path, 'utf8');
	return path.endsWith('.yaml') || path.endsWith('.yml')
		? parseYaml(source)
		: JSON.parse(source);
}

export async function validateFile(
	path: string,
	validator: ValidateFunction,
	/* Checks across the parsed document, run only once it matches the schema. */
	crossCheck?: (value: unknown) => readonly ValidationIssue[],
): Promise<FileValidation> {
	try {
		const value = await parseFile(path);
		const valid = validator(value);
		const issues = [
			...issuesFrom(validator.errors),
			...(valid && crossCheck ? crossCheck(value) : []),
		];
		return {
			file: path,
			valid: issues.every((issue) => issue.severity !== 'error'),
			issues,
		};
	} catch (error) {
		return {
			file: path,
			valid: false,
			issues: [
				{
					code: 'PARSE_ERROR',
					message: error instanceof Error ? error.message : String(error),
					severity: 'error',
				},
			],
		};
	}
}

/** Schema plus the cross-document checks of a module specification. */
export function validateModuleSpec(path: string): Promise<FileValidation> {
	return validateFile(path, validators.moduleSpec, moduleSpecIssues);
}

/* Dependencies, build output, and tool state are never workspace sources.
   Sandbox session workspaces live under .flowdular and must not register as
   modules of the host workspace. Other dot directories such as .ai hold
   blueprints and are searched. */
const SKIPPED_DIRECTORIES = new Set([
	'.git',
	'.flowdular',
	'.coreloom',
	'node_modules',
	'dist',
]);

export async function findNamedFiles(
	root: string,
	name: string,
): Promise<string[]> {
	const matches: string[] = [];
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.name === name) matches.push(path);
		}
	}
	await visit(root);
	return matches.sort();
}

/* Platform specifications are the top-level YAML files of the configured
   specs root; nested directories belong to other tooling. */
export async function listPlatformSpecs(root: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	return entries
		.filter((name) => /\.ya?ml$/.test(name))
		.sort()
		.map((name) => join(root, name));
}

const blueprintFiles = [
	'README.md',
	'input.schema.json',
	'plan.schema.json',
	'spec-requirements.yaml',
	'allowed-paths.yaml',
	'required-files.yaml',
	'steps.yaml',
	'gates.yaml',
] as const;

export async function validateBlueprint(path: string): Promise<FileValidation> {
	const report = await validateFile(path, validators.blueprint);
	const directory = dirname(path);
	const entries = new Set(
		(await readdir(directory)).filter((name) => basename(name) === name),
	);
	const missing = blueprintFiles.filter((name) => !entries.has(name));
	if (missing.length === 0) return report;
	const issues = [
		...report.issues,
		...missing.map((name) => ({
			code: 'BLUEPRINT_FILE_MISSING',
			message: `Required blueprint file is missing: ${name}`,
			path: relative(process.cwd(), join(directory, name)),
			severity: 'error' as const,
		})),
	];
	return { ...report, valid: false, issues };
}

export { validators };
