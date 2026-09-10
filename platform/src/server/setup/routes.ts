import { validateApplicationPath } from '@flowdular/server';
import { randomBytes } from 'node:crypto';
import { ServerRoute, type Context } from '@octanejs/app-core';
import {
	validateDatabaseSelection,
	type DatabaseAdapterConnectionInput,
	type DatabaseAdapterProbeResult,
	type DatabaseSafeConfiguration,
	type ModuleDatabaseRequirements,
} from '@flowdular/database';
import {
	readSetupSessionCookie,
	SETUP_CSRF_FIELD,
	setupSessionCookie,
	type SetupAccess,
	type SetupSession,
} from './access.ts';
import { setupSecretValues, type SetupAdapters } from './adapters.ts';
import {
	writeEnvironmentFile,
	type EnvironmentWriteResult,
} from './environment.ts';
import {
	renderSetupPage,
	type ModuleCompatibility,
	type SetupPageView,
} from './page.ts';
import { classifySetupFailure } from './sanitize.ts';
import { seedFirstRun, SetupSeedError, type FirstRunSeed } from './seed.ts';

const MAX_BODY_BYTES = 64 * 1024;
const FIELD_PREFIX = 'field:';

export interface SetupRoutesOptions {
	readonly environment: NodeJS.ProcessEnv;
	readonly defaultApplicationPath?: string;
	readonly webMountPaths?: readonly string[];
	readonly workspaceRoot: string;
	readonly adapters: SetupAdapters;
	readonly access: SetupAccess;
	readonly modules: readonly ModuleDatabaseRequirements[];
	/** True when the module list came from the manifest fallback, not from disk. */
	readonly modulesApproximated: boolean;
	readonly tokenFile: string | null;
	readonly secureCookies: boolean;
}

interface ReviewState {
	readonly kind: 'review';
	readonly adapterId: string;
	readonly input: DatabaseAdapterConnectionInput;
	readonly values: Readonly<Record<string, string>>;
	readonly probe: DatabaseAdapterProbeResult;
	readonly modules: readonly ModuleCompatibility[];
}

interface DoneState {
	readonly kind: 'done';
	readonly applicationPath: string;
	readonly seed: FirstRunSeed;
	readonly environment: EnvironmentWriteResult;
}

type FlowState = DoneState | ReviewState;

function flowState(session: SetupSession | null): FlowState | null {
	const pending = session?.pending;
	if (!pending || typeof pending !== 'object') return null;
	const kind = (pending as { kind?: unknown }).kind;
	return kind === 'review' || kind === 'done' ? (pending as FlowState) : null;
}

function emptyView(options: SetupRoutesOptions): SetupPageView {
	return {
		step: 'Unlock',
		csrfToken: null,
		error: null,
		notice: null,
		adapters: options.adapters.registry.list(),
		selectedAdapterId: null,
		fieldErrors: {},
		values: {
			applicationPath:
				options.environment.FD_APPLICATION_PATH ??
				options.defaultApplicationPath ??
				'/app',
		},
		probe: null,
		modules: [],
		environment: null,
		seed: null,
		modulesApproximated: options.modulesApproximated,
		tokenFile: options.tokenFile,
	};
}

function page(
	view: SetupPageView,
	status = 200,
	headers: Readonly<Record<string, string>> = {},
): Response {
	const nonce = randomBytes(16).toString('base64');
	return new Response(renderSetupPage(view, nonce), {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
			'referrer-policy': 'no-referrer',
			'x-frame-options': 'DENY',
			'content-security-policy': [
				"default-src 'none'",
				`style-src 'nonce-${nonce}'`,
				`script-src 'nonce-${nonce}'`,
				"img-src 'self' data:",
				"form-action 'self'",
				"base-uri 'none'",
				"frame-ancestors 'none'",
			].join('; '),
			...headers,
		},
	});
}

function redirect(
	location: string,
	headers: Record<string, string> = {},
): Response {
	return new Response(null, {
		status: 303,
		headers: { location, 'cache-control': 'no-store', ...headers },
	});
}

async function readForm(request: Request): Promise<FormData | null> {
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
	try {
		return await request.formData();
	} catch {
		return null;
	}
}

function formString(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

/* Form values arrive as `field:<adapterId>:<key>` so every adapter's inputs
   can be present at once and a submission still names exactly one adapter. */
function connectionInput(
	form: FormData,
	adapterId: string,
	adapters: SetupAdapters,
): {
	readonly input: DatabaseAdapterConnectionInput;
	readonly values: Record<string, string>;
} {
	const adapter = adapters.get(adapterId);
	const config: Record<string, string> = {};
	const secrets: Record<string, string> = {};
	const values: Record<string, string> = {};
	for (const definition of adapter?.descriptor.configurationSchema.fields ??
		[]) {
		const name = `${FIELD_PREFIX}${adapterId}:${definition.key}`;
		const value = formString(form, name).trim();
		if (definition.secret) secrets[definition.key] = value;
		else {
			config[definition.key] = value;
			values[name] = value;
		}
	}
	return {
		input: {
			config: config as DatabaseSafeConfiguration,
			secrets,
		},
		values,
	};
}

function compatibility(
	adapters: SetupAdapters,
	adapterId: string,
	modules: readonly ModuleDatabaseRequirements[],
): readonly ModuleCompatibility[] {
	const issues = validateDatabaseSelection(
		adapters.registry,
		{ version: 1, defaultAdapterId: adapterId },
		modules,
	);
	return modules.map((module) => ({
		moduleId: module.moduleId,
		tenantOwned: module.tenantOwned,
		issues: issues
			.filter((issue) => issue.moduleId === module.moduleId)
			.map((issue) => issue.message),
	}));
}

export function createSetupRoutes(
	options: SetupRoutesOptions,
): readonly ServerRoute[] {
	const base = emptyView(options);

	const unlockView = (
		error: string | null,
		status: number,
		headers: Record<string, string> = {},
	): Response => page({ ...base, error }, status, headers);

	const configureView = (
		session: SetupSession,
		overrides: Partial<SetupPageView> = {},
	): Response =>
		page({
			...base,
			step: 'Database',
			csrfToken: session.csrfToken,
			...overrides,
		});

	const reviewView = (
		session: SetupSession,
		state: ReviewState,
		error: string | null = null,
	): Response =>
		page({
			...base,
			step: 'Review',
			csrfToken: session.csrfToken,
			selectedAdapterId: state.adapterId,
			values: state.values,
			probe: state.probe,
			modules: state.modules,
			error,
		});

	const doneView = (session: SetupSession, state: DoneState): Response =>
		page({
			...base,
			step: 'Sign in',
			csrfToken: session.csrfToken,
			seed: state.seed,
			values: { applicationPath: state.applicationPath },
			environment: state.environment,
		});

	const render = (context: Context): Response => {
		const session = options.access.resume(
			readSetupSessionCookie(context.request.headers.get('cookie')),
		);
		if (!session) return unlockView(null, 200);
		const state = flowState(session);
		if (state?.kind === 'done') return doneView(session, state);
		if (state?.kind === 'review') return reviewView(session, state);
		return configureView(session);
	};

	const unlock = async (
		context: Context,
		form: FormData,
	): Promise<Response> => {
		const result = options.access.open(formString(form, 'token').trim());
		if (result.verdict === 'locked') {
			return unlockView(
				'Too many incorrect tokens. Setup is locked for a few minutes; restarting this deployment issues a new token.',
				429,
				{ 'retry-after': String(Math.ceil(result.retryAfterMs / 1000)) },
			);
		}
		if (result.verdict === 'denied' || !result.session) {
			return unlockView('That is not the setup token for this run.', 401);
		}
		/* A forwarded protocol header can only add the Secure flag, never remove
		   it, so trusting one here cannot widen where the cookie travels. */
		const secure =
			options.secureCookies ||
			new URL(context.request.url).protocol === 'https:' ||
			context.request.headers.get('x-forwarded-proto') === 'https';
		return redirect('/setup', {
			'set-cookie': setupSessionCookie(result.session.id, secure),
		});
	};

	const configure = async (
		session: SetupSession,
		form: FormData,
	): Promise<Response> => {
		const adapterId = formString(form, 'adapter').trim();
		const adapter = options.adapters.get(adapterId);
		if (!adapter) {
			return configureView(session, {
				error: 'Choose one of the databases listed above.',
			});
		}
		const { input, values } = connectionInput(
			form,
			adapterId,
			options.adapters,
		);
		values.applicationPath =
			formString(form, 'applicationPath').trim() ||
			options.environment.FD_APPLICATION_PATH ||
			options.defaultApplicationPath ||
			'/app';
		const fieldErrors: Record<string, string> = {};
		try {
			validateApplicationPath(values.applicationPath);
			if (
				options.webMountPaths?.some(
					(path) =>
						path === values.applicationPath ||
						path.startsWith(values.applicationPath + '/'),
				)
			) {
				fieldErrors.applicationPath =
					'This address overlaps a configured public module. Choose another backoffice address.';
			}
			if (
				options.environment.FD_APPLICATION_PATH &&
				values.applicationPath !== options.environment.FD_APPLICATION_PATH
			) {
				fieldErrors.applicationPath =
					'This address is set by FD_APPLICATION_PATH. Change that environment setting before restarting setup.';
			}
		} catch {
			fieldErrors.applicationPath =
				'Use one path such as /app or /backoffice (up to 64 characters, lowercase letters, digits and hyphens). System addresses are reserved.';
		}
		for (const issue of adapter.descriptor.validate(input)) {
			fieldErrors[issue.field] ??= issue.message;
		}
		if (Object.keys(fieldErrors).length > 0) {
			return configureView(session, {
				selectedAdapterId: adapterId,
				values,
				fieldErrors,
				error:
					'Some values need attention before the connection can be tested.',
			});
		}
		const probe = await adapter.descriptor.probe(input);
		const modules = compatibility(options.adapters, adapterId, options.modules);
		const state: ReviewState = {
			kind: 'review',
			adapterId,
			input,
			values,
			probe,
			modules,
		};
		session.pending = state;
		return reviewView(session, state);
	};

	const apply = async (
		session: SetupSession,
		state: ReviewState,
	): Promise<Response> => {
		const adapter = options.adapters.get(state.adapterId);
		if (!adapter) {
			return reviewView(session, state, 'That database is no longer offered.');
		}
		if (state.probe.status !== 'ready') {
			return reviewView(
				session,
				state,
				'The connection test did not succeed, so nothing was applied.',
			);
		}
		if (state.modules.some((module) => module.issues.length > 0)) {
			return reviewView(
				session,
				state,
				'One or more enabled modules cannot run on this database, so nothing was applied.',
			);
		}
		const secrets = setupSecretValues(state.input);
		let seed: FirstRunSeed;
		try {
			await adapter.descriptor.provision(state.input, {
				intent: 'confirmed-first-run',
			});
			const provider = adapter.openProvider(state.input);
			try {
				seed = await seedFirstRun(
					provider,
					options.environment,
					options.workspaceRoot,
				);
			} finally {
				await provider.dispose();
			}
			/* Readiness under the runtime role, proved after the schema exists and
			   every pool the seed used is closed. */
			const handle = await adapter.descriptor.connect(state.input);
			await handle.dispose();
		} catch (error) {
			if (error instanceof SetupSeedError) {
				return reviewView(session, state, error.message);
			}
			return reviewView(
				session,
				state,
				classifySetupFailure(error, secrets).message,
			);
		}
		/* Configuration is stored last: an earlier failure leaves this deployment
		   exactly as it was, still unconfigured, still on this screen. */
		const done: DoneState = {
			kind: 'done',
			applicationPath: state.values.applicationPath!,
			seed,
			environment: writeEnvironmentFile(options.workspaceRoot, {
				...adapter.environment(state.input),
				FD_APPLICATION_PATH: state.values.applicationPath!,
			}),
		};
		session.pending = done;
		return doneView(session, done);
	};

	const submit = async (context: Context): Promise<Response> => {
		const form = await readForm(context.request);
		if (!form) return unlockView('That request could not be read.', 400);
		const step = formString(form, 'step');
		if (step === 'unlock') return unlock(context, form);
		const session = options.access.resume(
			readSetupSessionCookie(context.request.headers.get('cookie')),
		);
		if (!session) {
			return unlockView('The setup session expired. Unlock setup again.', 401);
		}
		if (
			!options.access.verifyCsrf(session, formString(form, SETUP_CSRF_FIELD))
		) {
			/* The form did not come from this setup session. Dropping the session
			   makes the next step start from the token again. */
			options.access.close();
			return unlockView('That form was not accepted. Unlock setup again.', 403);
		}
		const state = flowState(session);
		if (state?.kind === 'done') return doneView(session, state);
		if (step === 'back') {
			session.pending = null;
			return configureView(
				session,
				state?.kind === 'review'
					? { values: state.values, selectedAdapterId: state.adapterId }
					: {},
			);
		}
		if (step === 'configure') return configure(session, form);
		if (step === 'apply' && state?.kind === 'review') {
			return apply(session, state);
		}
		return render(context);
	};

	/* Only these paths exist while the platform has no database. Everything else
	   is one redirect to the installer, because there is nothing else to serve. */
	return [
		new ServerRoute({
			path: '/setup',
			methods: ['GET', 'POST'],
			handler: (context) =>
				context.request.method === 'POST' ? submit(context) : render(context),
		}),
		new ServerRoute({
			path: '/',
			methods: ['GET'],
			handler: () => redirect('/setup'),
		}),
		new ServerRoute({
			path: '/api/*path',
			methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
			handler: () =>
				new Response(
					JSON.stringify({
						error: {
							code: 'PLATFORM_NOT_CONFIGURED',
							message:
								'This deployment has no database yet. Complete the first-run setup at /setup.',
						},
					}),
					{
						status: 503,
						headers: {
							'content-type': 'application/json; charset=utf-8',
							'cache-control': 'no-store',
						},
					},
				),
		}),
		new ServerRoute({
			path: '/*path',
			methods: ['GET'],
			handler: () => redirect('/setup'),
		}),
	];
}
