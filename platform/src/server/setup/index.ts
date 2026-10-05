import process from 'node:process';
import type { ServerRoute } from '@octanejs/app-core';
import {
	authRuntimeOptionsFromEnvironment,
	createAuthRuntime,
} from '@flowdular/module-auth/server';
import {
	createPlatformDatabaseProvider,
	databaseProviderConfigFromEnvironment,
} from '../database.ts';
import { createSetupAccess } from './access.ts';
import { createSetupAdapters } from './adapters.ts';
import { createFirstRunGate, type FirstRunGate } from './gate.ts';
import { enabledDatabaseModules } from './modules.ts';
import { createSetupHandler, createSetupRoutes } from './routes.ts';
import { issueSetupToken } from './token.ts';

export { clearSetupToken } from './token.ts';

const FIRST_RUN_SYMBOL = Symbol.for('flowdular.platform.first-run-setup');

export interface FirstRunSetup {
	readonly routes: readonly ServerRoute[];
	readonly token: string;
	readonly tokenFile: string | null;
}

export interface FirstRunSetupOptions {
	readonly environment: NodeJS.ProcessEnv;
	readonly workspaceRoot: string;
	readonly databasePreconfigured?: boolean;
	readonly applicationPath?: string;
	readonly webMountPaths?: readonly string[];
	readonly log?: (message: string) => void;
}

/** A reachable, empty configured database still needs its first owner.
 * Auth's normal migration path is used before the read, and an outage throws
 * rather than accidentally opening setup against an existing installation.
 */
export async function configuredDatabaseNeedsFirstRun(
	environment: NodeJS.ProcessEnv,
	workspaceRoot: string,
): Promise<boolean> {
	const databases = createPlatformDatabaseProvider(
		databaseProviderConfigFromEnvironment(environment, workspaceRoot),
	);
	try {
		await databases.check();
		const auth = createAuthRuntime({
			...authRuntimeOptionsFromEnvironment(environment, workspaceRoot),
			databases,
		});
		try {
			return !(await (await auth.service()).hasAnyTenant());
		} finally {
			await auth.dispose();
		}
	} finally {
		await databases.dispose();
	}
}

type ProcessWithSetup = NodeJS.Process & {
	[FIRST_RUN_SYMBOL]?: FirstRunSetup;
};

function origin(environment: NodeJS.ProcessEnv): string {
	const configured = environment.FD_AUTH_PUBLIC_ORIGIN?.trim();
	if (configured) return configured.replace(/\/+$/, '');
	return `http://127.0.0.1:${environment.PORT?.trim() || '4310'}`;
}

/**
 * The routes a deployment serves while it has no database. Held on the process
 * so a development re-evaluation of the configuration keeps the token, the
 * lockout counter, and the operator's half-finished session alive; a
 * production process evaluates the configuration once, so this is a plain
 * construction there.
 */
export function createFirstRunSetup(
	options: FirstRunSetupOptions,
): FirstRunSetup {
	const owner = process as ProcessWithSetup;
	const existing = owner[FIRST_RUN_SYMBOL];
	if (existing) return existing;
	const production = options.environment.NODE_ENV === 'production';
	const issued = issueSetupToken({
		workspaceRoot: options.workspaceRoot,
		origin: origin(options.environment),
	});
	const adapters = createSetupAdapters({
		workspaceRoot: options.workspaceRoot,
		production,
	});
	const enabled = enabledDatabaseModules(options.workspaceRoot);
	const setup: FirstRunSetup = {
		token: issued.token,
		tokenFile: issued.file,
		routes: createSetupRoutes({
			environment: options.environment,
			databasePreconfigured: options.databasePreconfigured ?? false,
			defaultApplicationPath: options.applicationPath ?? '/app',
			webMountPaths: options.webMountPaths ?? [],
			workspaceRoot: options.workspaceRoot,
			adapters,
			access: createSetupAccess(issued.token),
			modules: enabled.modules,
			modulesApproximated: enabled.approximated,
			tokenFile: issued.file,
			secureCookies:
				options.environment.FD_AUTH_SECURE_COOKIE === 'false'
					? false
					: production,
		}),
	};
	owner[FIRST_RUN_SYMBOL] = setup;
	(options.log ?? console.log)(issued.banner);
	return setup;
}

export interface InPlaceFirstRunOptions {
	readonly environment: NodeJS.ProcessEnv;
	readonly workspaceRoot: string;
	readonly applicationPath: string;
	readonly webMountPaths: readonly string[];
	readonly passThrough: readonly string[];
	readonly workspaceExists: () => Promise<boolean>;
	readonly log?: (message: string) => void;
}

/**
 * First run for a deployment that can neither restart itself nor write files,
 * such as a Vercel Function: the composed application serves setup behind a
 * gate until a workspace exists. The deploy command keeps the token and the
 * deployment holds only its SHA-256, so nothing is issued or written here.
 */
export function createInPlaceFirstRun(
	options: InPlaceFirstRunOptions,
): FirstRunGate {
	const digest = options.environment.FD_SETUP_TOKEN_SHA256?.trim();
	if (!digest) {
		throw new Error(
			'The database has no workspace yet and FD_SETUP_TOKEN_SHA256 is not set. Run flowdular deploy start vercel --apply, which sets it and prints the setup token.',
		);
	}
	const access = createSetupAccess({ sha256: digest });
	const production = options.environment.NODE_ENV === 'production';
	const adapters = createSetupAdapters({
		workspaceRoot: options.workspaceRoot,
		production,
	});
	const enabled = enabledDatabaseModules(options.workspaceRoot);
	const gate = createFirstRunGate({
		applicationPath: options.applicationPath,
		passThrough: options.passThrough,
		workspaceExists: options.workspaceExists,
		setup: (claimed) =>
			createSetupHandler({
				environment: options.environment,
				databasePreconfigured: true,
				defaultApplicationPath: options.applicationPath,
				webMountPaths: options.webMountPaths,
				workspaceRoot: options.workspaceRoot,
				adapters,
				access,
				modules: enabled.modules,
				modulesApproximated: enabled.approximated,
				tokenFile: null,
				secureCookies:
					options.environment.FD_AUTH_SECURE_COOKIE === 'false'
						? false
						: production,
				inPlace: { onClaimed: claimed },
			}),
	});
	(options.log ?? console.log)(
		'No workspace exists yet. Open /setup and enter the setup token the deploy command printed.',
	);
	return gate;
}
