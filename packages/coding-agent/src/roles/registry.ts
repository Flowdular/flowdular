import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CodingAgentError } from '../types.ts';
import {
	SANDBOX_AGENT_CONTRACT,
	composeSessionFacts,
	type InstructionContext,
} from './contract.ts';
import { DEFAULT_AGENT_ROLES, type AgentRoleDefinition } from './defaults.ts';

export const SANDBOX_ROLE_DIRECTORY = '.ai/agents/sandbox';

interface RoleFrontMatter {
	readonly id?: string;
	readonly name?: string;
	readonly purpose?: string;
	readonly allowedPaths?: readonly string[];
	readonly gates?: readonly string[];
	readonly handoff?: readonly string[];
}

function stringList(value: unknown, field: string): readonly string[] {
	if (
		!Array.isArray(value) ||
		value.some((entry) => typeof entry !== 'string')
	) {
		throw new CodingAgentError(
			'INVALID_ROLE',
			`Role field ${field} must be a list of strings.`,
		);
	}
	return value as readonly string[];
}

export function parseRoleDocument(source: string): AgentRoleDefinition {
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
	if (!match) {
		throw new CodingAgentError(
			'INVALID_ROLE',
			'A role document needs YAML front matter followed by its instruction.',
		);
	}
	const meta = (parseYaml(match[1]!) ?? {}) as RoleFrontMatter;
	const instruction = match[2]!.trim();
	if (!meta.id || !meta.name || !meta.purpose || !instruction) {
		throw new CodingAgentError(
			'INVALID_ROLE',
			'A role document needs id, name, purpose, and an instruction body.',
		);
	}
	return {
		id: meta.id,
		name: meta.name,
		purpose: meta.purpose,
		allowedPaths: stringList(meta.allowedPaths ?? [], 'allowedPaths'),
		gates: stringList(meta.gates ?? [], 'gates'),
		handoff: stringList(meta.handoff ?? [], 'handoff'),
		instruction,
	};
}

function yamlScalar(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export function renderRoleDocument(role: AgentRoleDefinition): string {
	const front = [
		'---',
		`id: ${role.id}`,
		`name: ${yamlScalar(role.name)}`,
		`purpose: ${yamlScalar(role.purpose)}`,
		'allowedPaths:',
		...role.allowedPaths.map((path) => `  - ${yamlScalar(path)}`),
		'gates:',
		...role.gates.map((gate) => `  - ${gate}`),
		'handoff:',
		...role.handoff.map((handoff) => `  - ${handoff}`),
		'---',
		'',
	].join('\n');
	return `${front}${role.instruction}\n`;
}

/* Roles are workspace configuration. Bundled defaults apply until a workspace
   writes its own under .ai/agents/sandbox, which then wins by id. */
export async function loadAgentRoles(
	workspaceRoot: string,
): Promise<readonly AgentRoleDefinition[]> {
	const roles = new Map(DEFAULT_AGENT_ROLES.map((role) => [role.id, role]));
	const directory = join(workspaceRoot, SANDBOX_ROLE_DIRECTORY);
	let entries: readonly string[];
	try {
		entries = await readdir(directory);
	} catch {
		return [...roles.values()];
	}
	for (const entry of entries) {
		if (!entry.endsWith('.md')) continue;
		const role = parseRoleDocument(
			await readFile(join(directory, entry), 'utf8'),
		);
		roles.set(role.id, role);
	}
	return [...roles.values()].sort((left, right) =>
		left.id.localeCompare(right.id),
	);
}

export async function materializeAgentRoles(
	workspaceRoot: string,
	roles: readonly AgentRoleDefinition[] = DEFAULT_AGENT_ROLES,
): Promise<readonly string[]> {
	const directory = join(workspaceRoot, SANDBOX_ROLE_DIRECTORY);
	await mkdir(directory, { recursive: true });
	const written: string[] = [];
	for (const role of roles) {
		const path = join(directory, `${role.id}.md`);
		await writeFile(path, renderRoleDocument(role), 'utf8');
		written.push(`${SANDBOX_ROLE_DIRECTORY}/${role.id}.md`);
	}
	return written;
}

export function findRole(
	roles: readonly AgentRoleDefinition[],
	id: string,
): AgentRoleDefinition {
	const role = roles.find((candidate) => candidate.id === id);
	if (!role) {
		throw new CodingAgentError('UNKNOWN_ROLE', `Unknown agent role: ${id}`);
	}
	return role;
}

export function composeInstruction(
	role: AgentRoleDefinition,
	context: InstructionContext,
): string {
	return [
		SANDBOX_AGENT_CONTRACT,
		'',
		`Role: ${role.name}`,
		role.purpose,
		'',
		role.instruction,
		'',
		composeSessionFacts(context),
	].join('\n');
}
