import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionModule } from './sessions.ts';

export const SPEC_FILE = 'spec/module.yaml';

export interface SpecDependency {
	readonly id: string;
	readonly range: string;
}

export interface SpecPermission {
	readonly id: string;
	readonly description: string;
}

export interface SpecScenario {
	readonly id: string;
	readonly given: string;
	readonly when: string;
	readonly then: string;
}

/* The part of packages/contracts/schemas/module-spec.schema.json the sandbox
   renders and diffs. The spec-schema gate stays the authority on validity; this
   reader only has to be honest about what it could read. */
export interface ModuleSpecDocument {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly specVersion: string;
	readonly status: string;
	readonly profile: string;
	readonly tenancy: string;
	readonly capabilities: readonly string[];
	readonly locales: readonly string[];
	readonly dependencies: readonly SpecDependency[];
	readonly invariants: readonly string[];
	readonly dataOwnership: readonly string[];
	readonly permissions: readonly SpecPermission[];
	readonly acceptanceScenarios: readonly SpecScenario[];
}

export type SpecChangeKind = 'added' | 'removed' | 'changed';

export interface SpecFieldChange {
	readonly field: string;
	readonly kind: SpecChangeKind;
	/* The entry inside a list field: a permission, dependency or scenario id, or
	   the sentence itself for a list of sentences. Null for a scalar field. */
	readonly key: string | null;
	readonly before: string | null;
	readonly after: string | null;
}

export interface ModuleSpecReview {
	/* The draft module directory the specification belongs to. */
	readonly module: string;
	readonly moduleId: string;
	readonly kind: 'new' | 'edit';
	/* Workspace-relative, so the browser never sees a host path. */
	readonly path: string;
	readonly present: boolean;
	readonly status: string | null;
	/* Null when the module has no specification to gate on yet. */
	readonly approved: boolean | null;
	readonly approvedAt: number | null;
	/* True when the draft differs from the copy the session started from. */
	readonly changed: boolean;
	readonly draft: ModuleSpecDocument | null;
	readonly base: ModuleSpecDocument | null;
	readonly changes: readonly SpecFieldChange[];
}

/* A specification is a small document. These bounds keep a pasted or generated
   file from turning a session view into an unbounded parse. */
const MAX_SPEC_BYTES = 256 * 1024;
const MAX_ITEMS = 200;
const MAX_VALUE = 2_000;

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/;
const NESTED_KEY = /^[ \t]+([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/;
const BULLET = /^[ \t]*-[ \t]+(.*)$/;
const STATUS_LINE = /^status:[ \t]*(\S+)[ \t]*$/m;

export function specPathOf(modulePath: string): string {
	return join(modulePath, SPEC_FILE);
}

export async function readSpecText(modulePath: string): Promise<string | null> {
	try {
		const text = await readFile(specPathOf(modulePath), 'utf8');
		return text.length > MAX_SPEC_BYTES ? null : text;
	} catch {
		return null;
	}
}

export function hashSpec(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function statusOf(text: string): string | null {
	return STATUS_LINE.exec(text)?.[1] ?? null;
}

/* The gate. A recorded hash is the operator's decision on that exact text, so
   any later edit re-opens it. The status line is presentation of that decision,
   not authority: only the approval route may record a hash. This keeps an
   agent, a workbench paste, or an old copied `status: approved` line from
   unblocking implementation or delivery. */
export function isSpecApproved(module: SessionModule, text: string): boolean {
	return module.specHash !== undefined && module.specHash === hashSpec(text);
}

export interface SpecGate {
	/* Null when the module has no specification file: there is nothing to
	   approve, and the routing sends the turn to the business manager anyway. */
	readonly approved: boolean | null;
	/* True when the draft differs from the copy the session started from, so a
	   change is on the table for the operator to review. */
	readonly changed: boolean;
}

export async function readSpecGate(
	module: SessionModule,
	modulePath: string,
	basePath: string,
): Promise<SpecGate> {
	const [draft, base] = await Promise.all([
		readSpecText(modulePath),
		readSpecText(basePath),
	]);
	return {
		approved: draft === null ? null : isSpecApproved(module, draft),
		changed: draft !== null && draft !== base,
	};
}

function unquote(value: string): string {
	const trimmed = value.trim().slice(0, MAX_VALUE);
	if (trimmed.length < 2) return trimmed;
	const quote = trimmed[0];
	if (quote !== "'" && quote !== '"') return trimmed;
	if (trimmed.at(-1) !== quote) return trimmed;
	const inner = trimmed.slice(1, -1);
	return quote === "'"
		? inner.replace(/''/g, "'")
		: inner.replace(/\\(["\\])/g, '$1');
}

/* A comment ends the line, unless the hash is inside a quoted scalar. */
function stripComment(line: string): string {
	if (/^[ \t]*#/.test(line)) return '';
	let quote = '';
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index]!;
		if (quote) {
			if (character === quote) quote = '';
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character === '#' && /[ \t]/.test(line[index - 1] ?? '')) {
			return line.slice(0, index);
		}
	}
	return line;
}

interface RawSpec {
	readonly scalars: Map<string, string>;
	readonly lists: Map<string, string[]>;
	readonly records: Map<string, Record<string, string>[]>;
}

/* The keys whose items are objects. Everything else under a key is a sentence,
   so an unquoted sentence that happens to start with a word and a colon stays a
   sentence instead of turning into a record. */
const OBJECT_FIELDS = new Set([
	'dependencies',
	'permissions',
	'acceptanceScenarios',
]);

/* The specification subset the schema allows: top-level scalars, lists of
   sentences, and lists of flat objects. Anything else is ignored rather than
   guessed at. */
function readSpec(text: string): RawSpec | null {
	const scalars = new Map<string, string>();
	const lists = new Map<string, string[]>();
	const records = new Map<string, Record<string, string>[]>();
	let list: string[] | null = null;
	let record: Record<string, string>[] | null = null;
	let current: Record<string, string> | null = null;
	for (const raw of text.split('\n')) {
		const line = stripComment(raw);
		if (!line.trim()) continue;
		const bullet = BULLET.exec(line);
		if (bullet) {
			const content = bullet[1]!;
			const pair = KEY_LINE.exec(content);
			if (record && pair) {
				current = { [pair[1]!]: unquote(pair[2]!) };
				if (record.length < MAX_ITEMS) record.push(current);
				continue;
			}
			if (list && list.length < MAX_ITEMS) list.push(unquote(content));
			continue;
		}
		const nested = NESTED_KEY.exec(line);
		if (nested && current) {
			current[nested[1]!] = unquote(nested[2]!);
			continue;
		}
		const pair = KEY_LINE.exec(line);
		if (!pair) continue;
		const key = pair[1]!;
		const value = pair[2]!.trim();
		list = null;
		record = null;
		current = null;
		if (value) {
			scalars.set(key, unquote(value));
			continue;
		}
		if (OBJECT_FIELDS.has(key)) {
			record = [];
			records.set(key, record);
			continue;
		}
		list = [];
		lists.set(key, list);
	}
	if (scalars.size === 0 && lists.size === 0 && records.size === 0) return null;
	return { scalars, lists, records };
}

function scalar(raw: RawSpec, key: string): string {
	return raw.scalars.get(key) ?? '';
}

function sentences(raw: RawSpec, key: string): readonly string[] {
	return raw.lists.get(key)?.filter(Boolean) ?? [];
}

function objects(
	raw: RawSpec,
	key: string,
	required: readonly string[],
): readonly Record<string, string>[] {
	return (raw.records.get(key) ?? []).filter((entry) =>
		required.every((field) => (entry[field] ?? '').length > 0),
	);
}

export function parseModuleSpec(text: string): ModuleSpecDocument | null {
	const raw = readSpec(text);
	if (!raw) return null;
	return {
		id: scalar(raw, 'id'),
		name: scalar(raw, 'name'),
		description: scalar(raw, 'description'),
		specVersion: scalar(raw, 'specVersion'),
		status: scalar(raw, 'status'),
		profile: scalar(raw, 'profile'),
		tenancy: scalar(raw, 'tenancy'),
		capabilities: sentences(raw, 'capabilities'),
		locales: sentences(raw, 'locales'),
		dependencies: objects(raw, 'dependencies', ['id', 'range']).map(
			(entry) => ({ id: entry.id!, range: entry.range! }),
		),
		invariants: sentences(raw, 'invariants'),
		dataOwnership: sentences(raw, 'dataOwnership'),
		permissions: objects(raw, 'permissions', ['id', 'description']).map(
			(entry) => ({ id: entry.id!, description: entry.description! }),
		),
		acceptanceScenarios: objects(raw, 'acceptanceScenarios', [
			'id',
			'given',
			'when',
			'then',
		]).map((entry) => ({
			id: entry.id!,
			given: entry.given!,
			when: entry.when!,
			then: entry.then!,
		})),
	};
}

export function scenarioText(scenario: SpecScenario): string {
	return `Given ${scenario.given} When ${scenario.when} Then ${scenario.then}`;
}

const SCALAR_FIELDS = [
	'specVersion',
	'status',
	'name',
	'description',
	'profile',
	'tenancy',
	'id',
] as const;

const SENTENCE_FIELDS = [
	'capabilities',
	'locales',
	'invariants',
	'dataOwnership',
] as const;

function scalarChanges(
	base: ModuleSpecDocument,
	draft: ModuleSpecDocument,
): readonly SpecFieldChange[] {
	const changes: SpecFieldChange[] = [];
	for (const field of SCALAR_FIELDS) {
		const before = base[field];
		const after = draft[field];
		if (before === after) continue;
		changes.push({
			field,
			kind: !before ? 'added' : !after ? 'removed' : 'changed',
			key: null,
			before: before || null,
			after: after || null,
		});
	}
	return changes;
}

function sentenceChanges(
	field: string,
	before: readonly string[],
	after: readonly string[],
): readonly SpecFieldChange[] {
	const had = new Set(before);
	const has = new Set(after);
	return [
		...after
			.filter((value) => !had.has(value))
			.map((value) => ({
				field,
				kind: 'added' as const,
				key: value,
				before: null,
				after: value,
			})),
		...before
			.filter((value) => !has.has(value))
			.map((value) => ({
				field,
				kind: 'removed' as const,
				key: value,
				before: value,
				after: null,
			})),
	];
}

/* A keyed list diffs by identity, so a reworded permission or scenario reads as
   one change instead of a removal plus an addition. */
function keyedChanges<T>(
	field: string,
	before: readonly T[],
	after: readonly T[],
	keyOf: (entry: T) => string,
	valueOf: (entry: T) => string,
): readonly SpecFieldChange[] {
	const had = new Map(before.map((entry) => [keyOf(entry), valueOf(entry)]));
	const has = new Map(after.map((entry) => [keyOf(entry), valueOf(entry)]));
	const changes: SpecFieldChange[] = [];
	for (const [key, value] of has) {
		const previous = had.get(key);
		if (previous === undefined) {
			changes.push({
				field,
				kind: 'added',
				key,
				before: null,
				after: value,
			});
			continue;
		}
		if (previous !== value) {
			changes.push({
				field,
				kind: 'changed',
				key,
				before: previous,
				after: value,
			});
		}
	}
	for (const [key, value] of had) {
		if (has.has(key)) continue;
		changes.push({ field, kind: 'removed', key, before: value, after: null });
	}
	return changes;
}

/* What this session changed in the specification, field by field. The order is
   stable: scalars first, then the lists in the order the document declares
   them, additions before removals. */
export function diffSpecs(
	base: ModuleSpecDocument | null,
	draft: ModuleSpecDocument | null,
): readonly SpecFieldChange[] {
	if (!draft || !base) return [];
	return [
		...scalarChanges(base, draft),
		...SENTENCE_FIELDS.flatMap((field) =>
			sentenceChanges(field, base[field], draft[field]),
		),
		...keyedChanges(
			'dependencies',
			base.dependencies,
			draft.dependencies,
			(entry) => entry.id,
			(entry) => entry.range,
		),
		...keyedChanges(
			'permissions',
			base.permissions,
			draft.permissions,
			(entry) => entry.id,
			(entry) => entry.description,
		),
		...keyedChanges(
			'acceptanceScenarios',
			base.acceptanceScenarios,
			draft.acceptanceScenarios,
			(entry) => entry.id,
			scenarioText,
		),
	];
}

/* Everything the review card renders for one module, and the gate state the
   turn refuses on: the draft, the copy the session started from, and the
   difference between them. */
export async function readModuleSpecReview(
	module: SessionModule,
	modulePath: string,
	basePath: string,
): Promise<ModuleSpecReview> {
	const [draftText, baseText] = await Promise.all([
		readSpecText(modulePath),
		readSpecText(basePath),
	]);
	const draft = draftText === null ? null : parseModuleSpec(draftText);
	const base = baseText === null ? null : parseModuleSpec(baseText);
	return {
		module: module.directory,
		moduleId: module.id,
		kind: module.kind,
		path: `modules/${module.directory}/${SPEC_FILE}`,
		present: draftText !== null,
		status: draftText === null ? null : statusOf(draftText),
		approved: draftText === null ? null : isSpecApproved(module, draftText),
		approvedAt: module.specApprovedAt ?? null,
		changed: draftText !== null && draftText !== baseText,
		draft,
		base,
		changes: diffSpecs(base, draft),
	};
}
