import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* Writing configuration is a real capability and a deployment may withhold it
   on purpose: infra/docker/compose.yaml sets read_only: true. A refused write
   is reported as a refused write, and the operator gets the exact block to
   paste into their orchestrator instead of a success that did not happen. */

export type EnvironmentWriteStatus =
	| 'failed'
	| 'read-only'
	| 'unchanged'
	| 'written';

export interface EnvironmentWriteResult {
	readonly status: EnvironmentWriteStatus;
	readonly path: string;
	/** Keys this run added to the file. */
	readonly added: readonly string[];
	/** Keys the file already set. An existing value is never replaced. */
	readonly kept: readonly string[];
	/** The block to paste when this deployment cannot persist it itself. */
	readonly block: string;
}

const BARE_VALUE = /^[A-Za-z0-9_@%:/.,+~=?&[\]{}!*()$^-]+$/;
const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

function quote(value: string): string {
	if (BARE_VALUE.test(value)) return value;
	if (value.includes('"') || value.includes('\\')) {
		throw new Error(
			'A value containing a quote or a backslash cannot be stored in a .env file.',
		);
	}
	return `"${value}"`;
}

function existingKeys(contents: string): ReadonlySet<string> {
	const keys = new Set<string>();
	for (const line of contents.split('\n')) {
		const match = KEY_LINE.exec(line);
		if (match?.[1]) keys.add(match[1]);
	}
	return keys;
}

export function renderEnvironmentBlock(
	values: Readonly<Record<string, string>>,
): string {
	return Object.entries(values)
		.map(([key, value]) => `${key}=${quote(value)}`)
		.join('\n');
}

function isReadOnly(error: unknown): boolean {
	const code =
		typeof error === 'object' && error !== null && 'code' in error
			? String((error as { code: unknown }).code)
			: '';
	return code === 'EROFS' || code === 'EACCES' || code === 'EPERM';
}

/**
 * Adds the keys this deployment is missing to `<workspaceRoot>/.env`, owner
 * readable only. A key the file already sets is left exactly as it is, so a
 * second run can never quietly re-point a database that is already configured.
 */
export function writeEnvironmentFile(
	workspaceRoot: string,
	values: Readonly<Record<string, string>>,
): EnvironmentWriteResult {
	const path = resolve(workspaceRoot, '.env');
	let block: string;
	try {
		block = renderEnvironmentBlock(values);
	} catch {
		/* A value a .env file cannot represent unambiguously. Reporting the keys
		   is the whole answer; writing a file that parses back differently is
		   the one outcome worse than not writing at all. */
		return {
			status: 'failed',
			path,
			added: [],
			kept: [],
			block: Object.keys(values).join('\n'),
		};
	}
	let contents = '';
	try {
		contents = readFileSync(path, 'utf8');
	} catch {
		/* No file yet, or it cannot be read. Either way nothing is overwritten:
		   an unreadable file makes the write below fail and report read-only. */
	}
	const present = existingKeys(contents);
	const added: string[] = [];
	const kept: string[] = [];
	for (const key of Object.keys(values)) {
		if (present.has(key)) kept.push(key);
		else added.push(key);
	}
	if (added.length === 0) {
		return { status: 'unchanged', path, added, kept, block };
	}
	const appended = added.map((key) => `${key}=${quote(values[key]!)}`);
	const next = [
		...(contents.length > 0 ? [contents.replace(/\n*$/, '\n')] : []),
		'# Written by the Flowdular first-run setup.\n',
		`${appended.join('\n')}\n`,
	].join('');
	/* A partial .env is worse than none, and a read-only mount must leave no
	   trace at all, so the file appears only once it is complete. */
	const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		writeFileSync(temporary, next, { encoding: 'utf8', mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		try {
			rmSync(temporary, { force: true });
		} catch {
			/* The temporary file was never created on a filesystem that refused
			   the write, so there is nothing to clean up. */
		}
		return {
			status: isReadOnly(error) ? 'read-only' : 'failed',
			path,
			added: [],
			kept,
			block,
		};
	}
	return { status: 'written', path, added, kept, block };
}
