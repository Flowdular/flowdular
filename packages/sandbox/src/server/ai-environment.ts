import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import {
	AI_PROVIDER_CATALOG,
	AI_PROVIDER_KINDS,
	DECISION_PROVIDER_CATALOG,
	type AiProviderKind,
	type DecisionProviderKind,
} from '@flowdular/ai-provider';

/* The variable each provider's own SDK documents, so a workspace that already
   exports a key for its other tools needs no sandbox setup at all. A kind whose
   credential has no published variable name takes it from model settings. */
export const AI_CREDENTIAL_VARIABLES: Readonly<
	Record<AiProviderKind, string | null>
> = Object.freeze({
	anthropic: 'ANTHROPIC_API_KEY',
	openai: 'OPENAI_API_KEY',
	azure: 'AZURE_API_KEY',
	vercel: 'AI_GATEWAY_API_KEY',
	'openai-compatible': null,
});

export type AiEnvironmentCredentials = Readonly<
	Partial<Record<AiProviderKind, string>>
>;

export interface EnvironmentProvider {
	readonly kind: AiProviderKind;
	readonly model: string;
	readonly credential: string;
	/* Named in the driver probe so an operator can see which key answered. */
	readonly variable: string;
}

const MAX_ENV_FILE_BYTES = 262_144;
const MAX_CREDENTIAL_LENGTH = 16_384;

function credentialValue(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_CREDENTIAL_LENGTH || /\s/.test(trimmed))
		return undefined;
	return trimmed;
}

/* Only the known credential names are taken out of the file: the rest of a
   workspace .env holds database and platform secrets the sandbox never needs. */
async function workspaceEnvironmentFile(
	workspaceRoot: string,
): Promise<Record<string, string | undefined>> {
	let source: string;
	try {
		const handle = await open(
			join(workspaceRoot, '.env'),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.size > MAX_ENV_FILE_BYTES) return {};
			source = await handle.readFile('utf8');
		} finally {
			await handle.close();
		}
	} catch {
		/* No readable .env: the process environment is the only source. */
		return {};
	}
	try {
		return parseEnv(source) as Record<string, string | undefined>;
	} catch {
		return {};
	}
}

/**
 * The provider credentials this workspace offers, by kind. The process
 * environment wins over the workspace `.env`, the same precedence `--env-file`
 * gives, so an exported key overrides the file without editing it.
 */
export async function readAiCredentials(
	workspaceRoot: string,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<AiEnvironmentCredentials> {
	let file: Record<string, string | undefined> | undefined;
	const credentials: Partial<Record<AiProviderKind, string>> = {};
	for (const kind of AI_PROVIDER_KINDS) {
		const variable = AI_CREDENTIAL_VARIABLES[kind];
		if (!variable) continue;
		const exported = credentialValue(environment[variable]);
		if (exported) {
			credentials[kind] = exported;
			continue;
		}
		file ??= await workspaceEnvironmentFile(workspaceRoot);
		const stored = credentialValue(file[variable]);
		if (stored) credentials[kind] = stored;
	}
	return credentials;
}

export function aiCredentialFor(
	credentials: AiEnvironmentCredentials,
	kind: AiProviderKind,
): string {
	return credentials[kind] ?? '';
}

/**
 * The provider to offer when the operator has configured none. A kind qualifies
 * only when the catalog knows a default model for it, so the sandbox never
 * guesses a model identifier the deployment has to own.
 */
export function environmentProvider(
	credentials: AiEnvironmentCredentials,
): EnvironmentProvider | null {
	for (const kind of AI_PROVIDER_KINDS) {
		const credential = credentials[kind];
		const model = AI_PROVIDER_CATALOG[kind].defaultModel;
		const variable = AI_CREDENTIAL_VARIABLES[kind];
		if (!credential || !model || !variable) continue;
		return { kind, model, credential, variable };
	}
	return null;
}

/**
 * The credential for a decision provider, read the same way and with the same
 * precedence as the model credentials.
 */
export async function readDecisionCredential(
	kind: DecisionProviderKind,
	workspaceRoot: string,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const variable = DECISION_PROVIDER_CATALOG[kind].credentialVariable;
	const exported = credentialValue(environment[variable]);
	if (exported) return exported;
	const file = await workspaceEnvironmentFile(workspaceRoot);
	return credentialValue(file[variable]) ?? '';
}
