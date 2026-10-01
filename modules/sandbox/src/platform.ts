import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import {
	createSandboxRoutes,
	createSandboxRuntime,
	sandboxSettingsFromEnvironment,
} from './server/index.ts';
import { provisionSandboxCredential } from './server/provision.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createSandboxRuntime({
		...sandboxSettingsFromEnvironment(context.environment),
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
	});
	return {
		routes: createSandboxRoutes(context.auth, runtime),
		prepare: async () => {
			/* The launcher asks for a credential through the environment rather
			   than an endpoint, because a machine that can reach an HTTP route can
			   reach every other one. Absent the variable this does nothing at all. */
			if (context.environment.FD_SANDBOX_PROVISION !== 'true') return;
			/* A failure here must not stop the application. This is a convenience
			   for a local operator, and an application that cannot serve because a
			   sandbox account could not be created is worse than one that serves
			   with the dashboard reporting the problem. */
			try {
				await provisionSandboxCredential({
					workspaceRoot: context.workspaceRoot,
					auth: context.auth,
					listGrants: (tenantId) =>
						runtime.service(context.auth).then((s) => s.listGrants(tenantId)),
					grant: (input) =>
						runtime.service(context.auth).then((s) =>
							s.grant({
								...input,
								capabilities: input.capabilities as Parameters<
									typeof s.grant
								>[0]['capabilities'],
							}),
						),
				});
			} catch (error) {
				console.error(
					'[sandbox.core] the sandbox credential was not prepared',
					error instanceof Error ? error.message : String(error),
				);
			}
		},
		dispose: () => runtime.dispose(),
	};
}
