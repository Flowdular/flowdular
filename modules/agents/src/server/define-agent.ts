import { createHash } from 'node:crypto';
import type {
	ModuleAgentDefinition,
	ModuleAgentDefinitionInput,
} from '../domain/types.ts';

const IDENTIFIER = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const KEY = /^[a-z][a-z0-9-]{1,62}[a-z0-9]$/;

function bounded(
	value: string,
	field: string,
	minimum: number,
	maximum: number,
): string {
	const normalized = value.trim();
	if (
		normalized.length < minimum ||
		normalized.length > maximum ||
		normalized.includes('\u0000')
	) {
		throw new Error(
			`${field} must contain between ${minimum} and ${maximum} supported characters.`,
		);
	}
	return normalized;
}

function positiveInteger(
	value: number,
	field: string,
	minimum: number,
	maximum: number,
): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(
			`${field} must be an integer between ${minimum} and ${maximum}.`,
		);
	}
	return value;
}

function temperature(value: number): number {
	if (!Number.isFinite(value) || value < 0 || value > 2) {
		throw new Error('limits.temperature must be between 0 and 2.');
	}
	return value;
}

function toolList(values: readonly string[]): readonly string[] {
	if (values.length > 32) {
		throw new Error('A module-owned agent can allow at most 32 tools.');
	}
	const tools = values.map((value) => value.trim());
	for (const tool of tools) {
		if (!IDENTIFIER.test(tool)) {
			throw new Error(
				`Agent tool ${tool || '(empty)'} is not a valid identifier.`,
			);
		}
	}
	if (new Set(tools).size !== tools.length) {
		throw new Error('A module-owned agent cannot list a tool more than once.');
	}
	return Object.freeze([...tools].sort());
}

/* Defines distributable business-agent behavior. Provider credentials, model
   selection and tenant authority deliberately live in the tenant binding. */
export function defineAgent(
	input: ModuleAgentDefinitionInput,
): ModuleAgentDefinition {
	const moduleId = input.moduleId.trim();
	if (!IDENTIFIER.test(moduleId)) {
		throw new Error(
			'moduleId must be a lowercase dot-separated module identifier.',
		);
	}
	const key = input.key.trim().toLowerCase();
	if (!KEY.test(key)) {
		throw new Error(
			'key must contain 3 to 64 lowercase letters, numbers, or hyphens.',
		);
	}
	const definitionRevision = positiveInteger(
		input.definitionRevision,
		'definitionRevision',
		1,
		Number.MAX_SAFE_INTEGER,
	);
	const id = `module-agent:${moduleId}:${key}`;
	if (id.length > 128) {
		throw new Error('The derived module agent id exceeds 128 characters.');
	}
	const limits = Object.freeze({
		maxSteps: positiveInteger(input.limits.maxSteps, 'limits.maxSteps', 1, 32),
		timeoutMs: positiveInteger(
			input.limits.timeoutMs,
			'limits.timeoutMs',
			250,
			86_400_000,
		),
		temperature: temperature(input.limits.temperature),
		maxOutputTokens: positiveInteger(
			input.limits.maxOutputTokens,
			'limits.maxOutputTokens',
			256,
			65_536,
		),
	});
	const ownership = Object.freeze({
		kind: 'module' as const,
		moduleId,
		definitionRevision,
	});
	return Object.freeze({
		id,
		moduleId,
		key,
		definitionRevision,
		name: bounded(input.name, 'name', 2, 120),
		description: bounded(input.description, 'description', 2, 500),
		instructions: bounded(input.instructions, 'instructions', 8, 40_000),
		allowedTools: toolList(input.allowedTools),
		limits,
		ownership,
	});
}

/* Reconciliation and the read-only boot preflight must accept and hash the
	 exact same normalized definition. Keeping that boundary here prevents the
	 safety check from drifting away from the write path. */
export function normalizeModuleAgentDefinitions(
	definitions: readonly ModuleAgentDefinition[],
): readonly ModuleAgentDefinition[] {
	const seen = new Set<string>();
	return definitions.map((definition) => {
		const checked = defineAgent(definition);
		if (checked.id !== definition.id) {
			throw new Error(
				`MODULE_AGENT_ID_MISMATCH: expected ${checked.id}, received ${definition.id}.`,
			);
		}
		if (seen.has(checked.id)) {
			throw new Error(`MODULE_AGENT_DUPLICATE: ${checked.id}`);
		}
		seen.add(checked.id);
		return checked;
	});
}

export function moduleAgentDefinitionHash(
	definition: ModuleAgentDefinition,
): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				definition.id,
				definition.moduleId,
				definition.key,
				definition.definitionRevision,
				definition.name,
				definition.description,
				definition.instructions,
				definition.allowedTools,
				definition.limits,
			]),
		)
		.digest('hex');
}
