import { randomBytes } from 'node:crypto';

/* The keys a fresh Flowdular install needs. Each one is a base64 encoded 32 byte
   value; auth.core uses the URL-safe variant for its MFA key. */
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
		secrets[key] = randomBytes(32).toString(
			key === 'FD_AUTH_MFA_KEY' ? 'base64url' : 'base64',
		);
	return secrets as GeneratedSecrets;
}

export function renderEnvironmentFile(secrets: GeneratedSecrets): string {
	return [
		'# Local configuration for this Flowdular app. Never commit it.',
		'# Regenerate service keys with: openssl rand -base64 32',
		'# For FD_AUTH_MFA_KEY use: openssl rand -hex 32',
		'',
		'# Local development runs on embedded PostgreSQL, so there is no server to',
		'# install and no connection string to configure. A deployment sets',
		'# FD_DATABASE_ADAPTER=postgresql and the FD_DATABASE_* URLs instead.',
		'FD_DATABASE_ADAPTER=pglite',
		'',
		'# 32 byte keys, generated once for this app; MFA uses base64url.',
		...SECRET_KEYS.map((key) => `${key}=${secrets[key]}`),
		'',
	].join('\n');
}
