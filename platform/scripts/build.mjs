import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDirectory = mkdtempSync(join(tmpdir(), 'flowdular-build-'));
const buildSecret = () => randomBytes(32).toString('base64');

/* The Octane plugin evaluates the server composition while bundling it. Give
   that build-time process isolated state and ephemeral keys, without using deployment database settings or encryption keys. The emitted server still reads its real
   production environment when it starts. */
const environment = {
	...process.env,
	/* A production bundle is evaluated while it is built, but the build must not
	   connect to the deployment database. The embedded engine writes into the
	   throwaway state directory below; runtime still reads its real adapter. */
	FD_ENV: 'development',
	FD_INTERNAL_BUILD: 'true',
	/* The bundler evaluates the server composition. It must not open a trace or
	   error egress to the deployment's collector while building. */
	FD_TRACE_EXPORTER: 'none',
	FD_ERROR_SINK: 'none',
	FD_DATABASE_ADAPTER: 'pglite',
	FD_DATABASE_PGLITE_DIRECTORY: join(stateDirectory, 'pglite'),
	FD_AGENT_CREDENTIAL_KEY: buildSecret(),
	FD_AGENT_RUN_GRANT_KEY: buildSecret(),
	FD_AUTOMATIONS_CREDENTIAL_KEY: buildSecret(),
	FD_NOTIFICATIONS_SECRET_KEY: buildSecret(),
	FD_WORKFLOWS_PAYLOAD_KEY: buildSecret(),
	FD_WORKFLOWS_CURSOR_KEY: buildSecret(),
	FD_STORAGE_ADAPTER: 'local',
	FD_STORAGE_LOCAL_DIRECTORY: join(stateDirectory, 'storage'),
	FD_STORAGE_ENCRYPTION_KEY: buildSecret(),
	FD_CONNECTORS_SECRET_KEY: buildSecret(),
	FD_AUDIT_ANCHOR_KEY: buildSecret(),
};

try {
	const result = spawnSync('vite', ['build'], {
		env: environment,
		stdio: 'inherit',
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(stateDirectory, { recursive: true, force: true });
}
