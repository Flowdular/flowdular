import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeliveryBudget } from './types.ts';

export type PolicyValue =
	| string
	| number
	| boolean
	| null
	| readonly string[]
	| PolicyMap;

export interface PolicyMap {
	readonly [key: string]: PolicyValue;
}

interface Line {
	readonly indent: number;
	readonly text: string;
}

function scalar(raw: string): PolicyValue {
	const value = raw.trim();
	if (value === '') return null;
	if (value === 'true') return true;
	if (value === 'false') return false;
	if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
	if (value.startsWith('[') && value.endsWith(']')) {
		return value
			.slice(1, -1)
			.split(',')
			.map((item) => unquote(item.trim()))
			.filter((item) => item !== '');
	}
	return unquote(value);
}

function unquote(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function stripComment(line: string): string {
	const hash = line.search(/(^|\s)#/);
	return hash < 0 ? line : line.slice(0, hash);
}

function splitKey(text: string): { key: string; rest: string } | null {
	if (text.endsWith(':')) return { key: text.slice(0, -1).trim(), rest: '' };
	const separator = text.indexOf(': ');
	if (separator < 0) return null;
	return {
		key: text.slice(0, separator).trim(),
		rest: text.slice(separator + 2).trim(),
	};
}

/* Reads the subset of YAML the policy files use: nested mappings, scalars,
   flow sequences (also one that continues on the next lines), and block
   sequences of scalars. Anchors, multi-line strings, and nested sequences are
   out of scope; the files are reviewed by hand and stay this simple. */
export function parsePolicyYaml(text: string): PolicyMap {
	const lines: Line[] = [];
	for (const raw of text.split('\n')) {
		const stripped = stripComment(raw).replace(/\s+$/, '');
		if (stripped.trim() === '') continue;
		lines.push({
			indent: stripped.length - stripped.trimStart().length,
			text: stripped.trim(),
		});
	}
	let index = 0;

	function readMap(indent: number): PolicyMap {
		const map: Record<string, PolicyValue> = {};
		while (index < lines.length) {
			const line = lines[index]!;
			if (line.indent < indent) break;
			if (line.indent > indent || line.text.startsWith('- ')) {
				index += 1;
				continue;
			}
			const entry = splitKey(line.text);
			index += 1;
			if (!entry) continue;
			if (entry.rest !== '') {
				map[entry.key] = readFlow(entry.rest);
				continue;
			}
			const next = lines[index];
			if (!next || next.indent <= indent) {
				map[entry.key] = null;
			} else if (next.text.startsWith('- ')) {
				map[entry.key] = readSequence(next.indent);
			} else if (next.text.startsWith('[')) {
				index += 1;
				map[entry.key] = readFlow(next.text);
			} else {
				map[entry.key] = readMap(next.indent);
			}
		}
		return map;
	}

	function readFlow(start: string): PolicyValue {
		let value = start;
		while (
			value.startsWith('[') &&
			!value.endsWith(']') &&
			index < lines.length
		) {
			value = `${value} ${lines[index]!.text}`;
			index += 1;
		}
		return scalar(value);
	}

	function readSequence(indent: number): readonly string[] {
		const items: string[] = [];
		while (index < lines.length) {
			const line = lines[index]!;
			if (line.indent !== indent || !line.text.startsWith('- ')) break;
			items.push(unquote(line.text.slice(2).trim()));
			index += 1;
		}
		return items;
	}

	return readMap(lines[0]?.indent ?? 0);
}

async function readPolicy(root: string, file: string): Promise<PolicyMap> {
	try {
		return parsePolicyYaml(
			await readFile(join(root, '.ai', 'policies', file), 'utf8'),
		);
	} catch {
		return {};
	}
}

function asMap(value: PolicyValue | undefined): PolicyMap {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as PolicyMap)
		: {};
}

function asInteger(value: PolicyValue | undefined): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
		? value
		: undefined;
}

export interface PathOwner {
	readonly pattern: string;
	readonly owner: string;
}

export interface PathOwnership {
	/* In file order; the first matching pattern answers for a path. */
	readonly owners: readonly PathOwner[];
	readonly requireReviewer: boolean;
}

export async function loadPathOwnership(root: string): Promise<PathOwnership> {
	const policy = await readPolicy(root, 'path-ownership.yaml');
	const owners: PathOwner[] = [];
	for (const [pattern, owner] of Object.entries(asMap(policy.owners))) {
		if (typeof owner === 'string') owners.push({ pattern, owner });
	}
	return {
		owners,
		requireReviewer: asMap(policy.crossOwnerChanges).requireReviewer === true,
	};
}

export interface TaskBudgets {
	readonly defaults: Partial<DeliveryBudget>;
	readonly overrides: Readonly<Record<string, Partial<DeliveryBudget>>>;
}

function budgetOf(value: PolicyValue | undefined): Partial<DeliveryBudget> {
	const map = asMap(value);
	const maxChangedFiles = asInteger(map.maxChangedFiles);
	const maxNewDependencies = asInteger(map.maxNewDependencies);
	return {
		...(maxChangedFiles !== undefined ? { maxChangedFiles } : {}),
		...(maxNewDependencies !== undefined ? { maxNewDependencies } : {}),
	};
}

export async function loadTaskBudgets(root: string): Promise<TaskBudgets> {
	const policy = await readPolicy(root, 'task-budgets.yaml');
	const overrides: Record<string, Partial<DeliveryBudget>> = {};
	for (const [kind, value] of Object.entries(asMap(policy.overrides))) {
		overrides[kind] = budgetOf(value);
	}
	return { defaults: budgetOf(policy.defaults), overrides };
}

const patternCache = new Map<string, RegExp>();

/* Globs as the policy files write them: `**` spans directories, `*` stays in
   one segment, `{module}` binds one segment. */
function patternRegExp(pattern: string): RegExp {
	let regExp = patternCache.get(pattern);
	if (regExp) return regExp;
	const source = pattern
		.split(/(\*\*|\*|\{module\})/)
		.map((part) => {
			if (part === '**') return '.*';
			if (part === '*') return '[^/]*';
			if (part === '{module}') return '([^/]+)';
			return part.replace(/[.+?^$()|[\]\\]/g, '\\$&');
		})
		.join('');
	regExp = new RegExp(`^${source}$`);
	if (patternCache.size >= 256) patternCache.clear();
	patternCache.set(pattern, regExp);
	return regExp;
}

export function matchesPath(path: string, pattern: string): boolean {
	return patternRegExp(pattern).test(path);
}

export function ownerOf(path: string, ownership: PathOwnership): string | null {
	for (const { pattern, owner } of ownership.owners) {
		const match = patternRegExp(pattern).exec(path);
		if (!match) continue;
		return match[1] ? owner.replace('{module}', match[1]) : owner;
	}
	return null;
}
