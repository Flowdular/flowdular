import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDirectory = mkdtempSync(join(tmpdir(), 'coreloom-build-'));
const buildSecret = () => randomBytes(32).toString('base64');
const database = (name) => join(stateDirectory, `${name}.db`);

/* The Octane plugin evaluates the server composition while bundling it. Give
   that build-time process isolated state and ephemeral keys, while preserving
   every explicitly supplied value. The emitted server still reads its real
   production environment when it starts. */
const environment = {
	...process.env,
	CL_AGENT_CREDENTIAL_KEY: process.env.CL_AGENT_CREDENTIAL_KEY ?? buildSecret(),
	CL_AGENT_RUN_GRANT_KEY: process.env.CL_AGENT_RUN_GRANT_KEY ?? buildSecret(),
	CL_AUTOMATIONS_CREDENTIAL_KEY:
		process.env.CL_AUTOMATIONS_CREDENTIAL_KEY ?? buildSecret(),
	CL_WORKFLOWS_PAYLOAD_KEY:
		process.env.CL_WORKFLOWS_PAYLOAD_KEY ?? buildSecret(),
	CL_WORKFLOWS_CURSOR_KEY: process.env.CL_WORKFLOWS_CURSOR_KEY ?? buildSecret(),
	CL_AGENTS_DATABASE: process.env.CL_AGENTS_DATABASE ?? database('agents'),
	CL_AUTH_DATABASE: process.env.CL_AUTH_DATABASE ?? database('auth'),
	CL_AUTOMATIONS_DATABASE:
		process.env.CL_AUTOMATIONS_DATABASE ?? database('automations'),
	CL_CATALOG_DATABASE: process.env.CL_CATALOG_DATABASE ?? database('catalog'),
	CL_EXPENSES_DATABASE:
		process.env.CL_EXPENSES_DATABASE ?? database('expenses'),
	CL_PARTIES_DATABASE: process.env.CL_PARTIES_DATABASE ?? database('parties'),
	CL_PROFILE_DATABASE: process.env.CL_PROFILE_DATABASE ?? database('profile'),
	CL_SANDBOX_DATABASE: process.env.CL_SANDBOX_DATABASE ?? database('sandbox'),
	CL_WORKFLOWS_DATABASE:
		process.env.CL_WORKFLOWS_DATABASE ?? database('workflows'),
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
