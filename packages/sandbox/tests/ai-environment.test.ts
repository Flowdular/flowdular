import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	AI_CREDENTIAL_VARIABLES,
	aiCredentialFor,
	environmentProvider,
	readAiCredentials,
} from '../src/server/ai-environment.ts';
import { sealSecret } from '../src/server/config.ts';
import { createSandboxRuntime } from '../src/server/runtime.ts';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function workspace(environmentFile?: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'flowdular-ai-env-'));
	roots.push(root);
	await writeFile(
		join(root, 'flowdular.json'),
		JSON.stringify({ schemaVersion: 1, modules: { roots: ['modules'] } }),
	);
	if (environmentFile !== undefined)
		await writeFile(join(root, '.env'), environmentFile);
	return root;
}

describe('workspace AI credentials', () => {
	it('reads a provider key from the workspace .env', async () => {
		const root = await workspace('ANTHROPIC_API_KEY=sk-from-file\n');

		const credentials = await readAiCredentials(root, {});

		expect(aiCredentialFor(credentials, 'anthropic')).toBe('sk-from-file');
	});

	it('lets an exported variable win over the file', async () => {
		const root = await workspace('ANTHROPIC_API_KEY=sk-from-file\n');

		const credentials = await readAiCredentials(root, {
			ANTHROPIC_API_KEY: 'sk-exported',
		});

		expect(aiCredentialFor(credentials, 'anthropic')).toBe('sk-exported');
	});

	/* The file also holds the database URL and every module's sealing key. */
	it('takes only the credential names out of the file', async () => {
		const root = await workspace(
			[
				'FD_DATABASE_URL=postgresql://runtime:secret@localhost:5432/app',
				'FD_AGENT_CREDENTIAL_KEY=aaaa',
				'OPENAI_API_KEY=sk-openai',
			].join('\n'),
		);

		const credentials = await readAiCredentials(root, {});

		expect(credentials).toEqual({ openai: 'sk-openai' });
	});

	it('ignores an empty, padded or oversized value', async () => {
		const root = await workspace(
			['ANTHROPIC_API_KEY=', 'OPENAI_API_KEY=sk one two'].join('\n'),
		);

		const credentials = await readAiCredentials(root, {
			AI_GATEWAY_API_KEY: 'x'.repeat(16_385),
		});

		expect(credentials).toEqual({});
	});

	it('survives a workspace without a readable .env', async () => {
		const root = await workspace();

		await expect(readAiCredentials(root, {})).resolves.toEqual({});
	});

	it('offers no variable for a kind whose credential has no standard name', () => {
		expect(AI_CREDENTIAL_VARIABLES['openai-compatible']).toBeNull();
	});
});

describe('provider derived from the environment', () => {
	it('takes the catalog default model for the kind that has one', () => {
		expect(environmentProvider({ anthropic: 'sk-test' })).toEqual({
			kind: 'anthropic',
			model: 'claude-sonnet-5',
			credential: 'sk-test',
			variable: 'ANTHROPIC_API_KEY',
		});
	});

	/* Guessing a deployment's model identifier would fail at the first turn. */
	it('offers nothing for a kind the catalog has no default model for', () => {
		expect(environmentProvider({ openai: 'sk-test' })).toBeNull();
	});

	it('offers nothing when the workspace exports no key', () => {
		expect(environmentProvider({})).toBeNull();
	});
});

describe('sandbox runtime drivers', () => {
	it('offers the provider the workspace .env carries when none is configured', async () => {
		const root = await workspace('ANTHROPIC_API_KEY=sk-from-file\n');

		const runtime = await createSandboxRuntime(root);

		expect(
			runtime
				.registry()
				.drivers()
				.map((driver) => driver.id),
		).toContain('byok');
	});

	it('names the adopted provider so setup can skip the key question', async () => {
		const root = await workspace('ANTHROPIC_API_KEY=sk-from-file\n');

		const runtime = await createSandboxRuntime(root);

		expect(runtime.aiEnvironment()).toEqual({
			kind: 'anthropic',
			model: 'claude-sonnet-5',
			variable: 'ANTHROPIC_API_KEY',
		});
	});

	it('stops naming the environment once a key is saved in setup', async () => {
		const root = await workspace('ANTHROPIC_API_KEY=sk-from-file\n');
		const runtime = await createSandboxRuntime(root);

		await runtime.update({
			byok: {
				kind: 'anthropic',
				model: 'claude-opus-5',
				credential: await sealSecret(root, 'sk-typed-in-setup'),
			},
		});

		expect(runtime.aiEnvironment()).toBeNull();
		expect(
			runtime
				.registry()
				.drivers()
				.map((driver) => driver.id),
		).toContain('byok');
	});

	it('offers no bring-your-own-key driver without a credential anywhere', async () => {
		const root = await workspace('FD_DATABASE_ADAPTER=pglite\n');

		const runtime = await createSandboxRuntime(root);

		expect(
			runtime
				.registry()
				.drivers()
				.map((driver) => driver.id),
		).not.toContain('byok');
	});
});
