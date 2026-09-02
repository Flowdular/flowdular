import { coreloomLocalDataPath } from '@coreloom/kernel/legacy-local-state';
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
	dispose(): void;
}

function sandboxUrl(value: string | undefined): string {
	const candidate = value?.trim() || 'http://127.0.0.1:4320';
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new Error('CL_SANDBOX_URL must be an absolute URL.');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('CL_SANDBOX_URL must use http or https.');
	}
	return url.origin;
}

export function sandboxRuntimeOptionsFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
	workspaceRoot = process.cwd(),
): SandboxRuntimeOptions {
	return {
		databasePath:
			environment.CL_SANDBOX_DATABASE ??
			(environment.NODE_ENV === 'production'
				? '/data/sandbox.db'
				: environment.NODE_ENV === 'test'
					? ':memory:'
					: coreloomLocalDataPath(workspaceRoot, 'sandbox.db')),
		sandboxUrl: sandboxUrl(environment.CL_SANDBOX_URL),
	};
}

export function createSandboxRuntime(
	options: SandboxRuntimeOptions = sandboxRuntimeOptionsFromEnvironment(),
): SandboxRuntime {
	let service: SandboxService | undefined;
	let repository: SqliteSandboxRepository | undefined;
	let disposed = false;
	return {
		options,
		service: (auth) => {
			if (disposed) throw new Error('Sandbox runtime is disposed.');
			repository ??= new SqliteSandboxRepository(options.databasePath);
			service ??= new SandboxService(
				repository,
				directoryFromAuthRuntime(auth),
			);
			return service;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			repository?.close();
			repository = undefined;
			service = undefined;
		},
	};
}
