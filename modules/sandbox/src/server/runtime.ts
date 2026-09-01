import { resolve } from 'node:path';
import type { AuthRuntime } from '@coreloom/module-auth/server';
import { directoryFromAuthRuntime } from '../services/directory.ts';
import { SandboxService } from '../services/sandbox-service.ts';
import { SqliteSandboxRepository } from '../services/sqlite-repository.ts';

export interface SandboxRuntimeOptions {
	readonly databasePath: string;
	/* Where the sandbox application is reachable. The platform only links to
	   it; it never proxies sandbox traffic. */
	readonly sandboxUrl: string;
}

export interface SandboxRuntime {
	readonly options: SandboxRuntimeOptions;
	service(auth: AuthRuntime): SandboxService;
}

function sandboxUrl(value: string | undefined): string {
	const candidate = value?.trim() || 'http://127.0.0.1:4320';
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new Error('OERP_SANDBOX_URL must be an absolute URL.');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('OERP_SANDBOX_URL must use http or https.');
	}
	return url.origin;
}

export function sandboxRuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): SandboxRuntimeOptions {
	return {
		databasePath:
			environment.OERP_SANDBOX_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/sandbox.db'
				: resolve(workspaceRoot, '.octane-erp/sandbox.db')),
		sandboxUrl: sandboxUrl(environment.OERP_SANDBOX_URL),
	};
}

export function createSandboxRuntime(
	options: SandboxRuntimeOptions = sandboxRuntimeOptionsFromEnvironment(),
): SandboxRuntime {
	let service: SandboxService | undefined;
	return {
		options,
		service: (auth) => {
			service ??= new SandboxService(
				new SqliteSandboxRepository(options.databasePath),
				directoryFromAuthRuntime(auth),
			);
			return service;
		},
	};
}
