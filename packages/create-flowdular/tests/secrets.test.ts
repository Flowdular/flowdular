import { describe, expect, it } from 'vitest';
import {
	generateSecrets,
	renderEnvironmentFile,
	SECRET_KEYS,
} from '../src/secrets.ts';

describe('generateSecrets', () => {
	it('generates one base64 encoded 32 byte key per secret', () => {
		const secrets = generateSecrets();

		expect(Object.keys(secrets).sort()).toEqual([...SECRET_KEYS].sort());
		for (const key of SECRET_KEYS) {
			expect(Buffer.from(secrets[key], 'base64')).toHaveLength(32);
		}
	});

	it('covers every module that refuses to boot in production without a key', () => {
		expect([...SECRET_KEYS]).toEqual(
			expect.arrayContaining([
				'FD_AGENT_CREDENTIAL_KEY',
				'FD_AGENT_RUN_GRANT_KEY',
				'FD_AUTOMATIONS_CREDENTIAL_KEY',
				'FD_WORKFLOWS_PAYLOAD_KEY',
				'FD_WORKFLOWS_CURSOR_KEY',
				'FD_NOTIFICATIONS_SECRET_KEY',
				'FD_STORAGE_ENCRYPTION_KEY',
				'FD_CONNECTORS_SECRET_KEY',
				'FD_AUDIT_ANCHOR_KEY',
			]),
		);
		expect(
			Buffer.from(generateSecrets().FD_AUTOMATIONS_CREDENTIAL_KEY, 'base64'),
		).toHaveLength(32);
	});

	it('never repeats a value inside one run', () => {
		const secrets = generateSecrets();

		expect(new Set(Object.values(secrets)).size).toBe(SECRET_KEYS.length);
	});

	it('produces different values on every run', () => {
		const runs = Array.from({ length: 8 }, () => generateSecrets());

		for (const key of SECRET_KEYS) {
			expect(new Set(runs.map((run) => run[key])).size).toBe(runs.length);
		}
	});
});

describe('renderEnvironmentFile', () => {
	it('selects the embedded PostgreSQL adapter and writes every key', () => {
		const secrets = generateSecrets();
		const contents = renderEnvironmentFile(secrets);

		expect(contents).toContain('FD_DATABASE_ADAPTER=pglite');
		for (const key of SECRET_KEYS) {
			expect(contents).toContain(`${key}=${secrets[key]}`);
		}
		expect(contents.endsWith('\n')).toBe(true);
	});

	it('ships no connection string a local run would have to edit', () => {
		expect(renderEnvironmentFile(generateSecrets())).not.toContain(
			'FD_DATABASE_URL=',
		);
	});
});
