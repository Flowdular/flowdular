import { randomBytes } from 'node:crypto';

/* The keys a fresh Flowdular install needs. Each one is a base64 encoded 32 byte
   value, the encoding agents.core, workflows.core and auth.core decode. */
export const SECRET_KEYS = [
	'FD_AGENT_CREDENTIAL_KEY',
	'FD_AGENT_RUN_GRANT_KEY',
	'FD_WORKFLOWS_PAYLOAD_KEY',
	'FD_WORKFLOWS_CURSOR_KEY',
	'FD_AUTH_MFA_KEY',
] as const;

export type SecretKey = (typeof SECRET_KEYS)[number];
export type GeneratedSecrets = Readonly<Record<SecretKey, string>>;

export function generateSecrets(): GeneratedSecrets {
	const secrets: Partial<Record<SecretKey, string>> = {};
	for (const key of SECRET_KEYS)
		secrets[key] = randomBytes(32).toString('base64');
	return secrets as GeneratedSecrets;
}

export function renderEnvironmentFile(secrets: GeneratedSecrets): string {
	return [
		'# Local configuration for this Flowdular app. Never commit it.',
		'# Regenerate any key with: openssl rand -base64 32',
		'',
		'# Local development runs on embedded PostgreSQL, so there is no server to',
		'# install and no connection string to configure. A deployment sets',
		'# FD_DATABASE_ADAPTER=postgresql and the FD_DATABASE_* URLs instead.',
		'FD_DATABASE_ADAPTER=pglite',
		'',
		'# Base64 encoded 32 byte keys, generated once for this app.',
		...SECRET_KEYS.map((key) => `${key}=${secrets[key]}`),
		'',
	].join('\n');
}
