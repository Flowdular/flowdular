import { validateApplicationPath } from '@flowdular/server';
import {
	assertPasswordPolicy,
	AuthServiceError,
	validateDisplayName,
	validateEmailAddress,
	validateWorkspaceName,
	validateWorkspaceSlug,
} from '@flowdular/module-auth/server';
import { AUTH_MODULE_SETTINGS } from '@flowdular/module-auth';
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
import {
	POSTGRESQL_ADAPTER_ID,
	setupSecretValues,
	type SetupAdapters,
} from './adapters.ts';
import {
	createPlatformDatabaseProvider,
	databaseProviderConfigFromEnvironment,
} from '../database.ts';
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
import {
	claimFirstRun,
	seedFirstRun,
	SetupSeedError,
	type FirstRunOwner,
	type FirstRunSeed,
} from './seed.ts';

const MAX_BODY_BYTES = 64 * 1024;
const FIELD_PREFIX = 'field:';

export interface SetupRoutesOptions {
	readonly environment: NodeJS.ProcessEnv;
	readonly databasePreconfigured: boolean;
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
	/** Supplied by tests; production exits after the completed page requests restart. */
	readonly restartApplication?: (exitCode: number) => void;
	/** Set when setup runs inside the composed application, which serves itself
	 *  once the first workspace exists instead of restarting. */
	readonly inPlace?: { readonly onClaimed: () => void } | undefined;
}

interface ConnectionState {
	readonly adapterId: string;
	readonly input: DatabaseAdapterConnectionInput | null;
	readonly values: Readonly<Record<string, string>>;
	readonly probe: DatabaseAdapterProbeResult | null;
	readonly modules: readonly ModuleCompatibility[];
}

interface DatabaseState extends ConnectionState {
	readonly kind: 'database';
}

interface ReviewState extends ConnectionState {
	readonly kind: 'review';
	readonly owner: FirstRunOwner;
}

interface DoneState {
	readonly kind: 'done';
	readonly applicationPath: string;
	readonly seed: FirstRunSeed;
	readonly environment: EnvironmentWriteResult | null;
}

type FlowState = DoneState | ReviewState | DatabaseState;

function flowState(session: SetupSession | null): FlowState | null {
	const pending = session?.pending;
	if (!pending || typeof pending !== 'object') return null;
	const kind = (pending as { kind?: unknown }).kind;
	return kind === 'database' || kind === 'review' || kind === 'done'
		? (pending as FlowState)
		: null;
}

function canAutoRestart(
	options: SetupRoutesOptions,
	state: DoneState,
): boolean {
	return (
		!options.inPlace &&
		options.environment.FD_SETUP_AUTO_RESTART === 'true' &&
		(options.databasePreconfigured ||
			state.environment?.status === 'written' ||
			state.environment?.status === 'unchanged')
	);
}

/* auth.core's rule for this variable: blank means the default, and a value
   outside the setting's bounds stops startup, as auth.core does at boot. */
function passwordMinLength(environment: NodeJS.ProcessEnv): number {
	const { defaultValue, min, max } =
		AUTH_MODULE_SETTINGS.settings.passwordMinLength!;
	const value = environment.FD_AUTH_PASSWORD_MIN_LENGTH;
	if (value === undefined || value.trim() === '') return Number(defaultValue);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < min! || parsed > max!) {
		throw new Error(
			`FD_AUTH_PASSWORD_MIN_LENGTH must be an integer between ${min} and ${max}.`,
		);
	}
	return parsed;
}

function emptyView(options: SetupRoutesOptions): SetupPageView {
	return {
		step: 'Unlock',
		databasePreconfigured: options.databasePreconfigured,
		inPlace: options.inPlace !== undefined,
		autoRestart:
			!options.inPlace &&
			options.databasePreconfigured &&
			options.environment.FD_SETUP_AUTO_RESTART === 'true',
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
		/* auth.core creates the owner with this minimum, so the workspace step
		   has to refuse what the final step would. */
		passwordMinLength: passwordMinLength(options.environment),
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
			'x-flowdular-setup': 'first-run',
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
			'referrer-policy': 'no-referrer',
			'x-frame-options': 'DENY',
			'content-security-policy': [
				"default-src 'none'",
				`style-src 'nonce-${nonce}'`,
				`script-src 'nonce-${nonce}'`,
				"img-src 'self' data:",
				"connect-src 'self'",
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
		if (!request.body) return null;
		const reader = request.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_BODY_BYTES) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
		const contentType = request.headers.get('content-type');
		if (!contentType) return null;
		return await new Response(Buffer.concat(chunks), {
			headers: { 'content-type': contentType },
		}).formData();
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

/** Serves GET and POST /setup. */
export function createSetupHandler(
	options: SetupRoutesOptions,
): (context: Context) => Promise<Response> {
	const base = emptyView(options);
	let restartScheduled = false;
	let applying = false;
	const preconfiguredState = (): DatabaseState => ({
		kind: 'database',
		adapterId: POSTGRESQL_ADAPTER_ID,
		input: null,
		values: base.values,
		probe: null,
		modules: compatibility(
			options.adapters,
			POSTGRESQL_ADAPTER_ID,
			options.modules,
		),
	});

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

	const workspaceView = (
		session: SetupSession,
		state: ConnectionState,
		overrides: Partial<SetupPageView> = {},
	): Response =>
		page({
			...base,
			step: 'Workspace',
			csrfToken: session.csrfToken,
			selectedAdapterId: state.adapterId,
			values: state.values,
			probe: state.probe,
			modules: state.modules,
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
			autoRestart: canAutoRestart(options, state),
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
		if (state?.kind === 'database') return workspaceView(session, state);
		if (options.databasePreconfigured)
			return workspaceView(session, preconfiguredState());
		return configureView(session);
	};

	const unlock = async (
		context: Context,
		form: FormData,
	): Promise<Response> => {
		const result = options.access.open(formString(form, 'token').trim());
		if (result.verdict === 'locked') {
			return unlockView(
				`Too many incorrect tokens. Setup is locked for a few minutes; ${options.inPlace ? 'running the deploy command again' : 'restarting this deployment'} issues a new token.`,
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
		if (options.databasePreconfigured)
			return workspaceView(session, preconfiguredState());
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
		const fieldErrors: Record<string, string> = {};
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
		if (probe.status !== 'ready') {
			return configureView(session, {
				selectedAdapterId: adapterId,
				values,
				error: probe.message ?? 'The connection could not be tested.',
			});
		}
		const modules = compatibility(options.adapters, adapterId, options.modules);
		const state: DatabaseState = {
			kind: 'database',
			adapterId,
			input,
			values: { ...values, applicationPath: base.values.applicationPath! },
			probe,
			modules,
		};
		session.pending = state;
		return workspaceView(session, state);
	};

	const workspace = (session: SetupSession, form: FormData): Response => {
		const pending = flowState(session);
		const database =
			pending?.kind === 'database' || pending?.kind === 'review'
				? pending
				: options.databasePreconfigured
					? preconfiguredState()
					: null;
		if (!database) return configureView(session);
		const values: Record<string, string> = {
			...database.values,
			workspaceName: formString(form, 'workspaceName').trim(),
			workspaceSlug: formString(form, 'workspaceSlug').trim(),
			ownerName: formString(form, 'ownerName').trim(),
			ownerEmail: formString(form, 'ownerEmail').trim(),
			applicationPath:
				formString(form, 'applicationPath').trim() ||
				base.values.applicationPath!,
		};
		const password = formString(form, 'ownerPassword');
		const passwordConfirm = formString(form, 'ownerPasswordConfirm');
		const fieldErrors: Record<string, string> = {};
		const validate = (key: string, action: () => string): string => {
			try {
				return action();
			} catch (error) {
				fieldErrors[key] =
					error instanceof AuthServiceError
						? error.message
						: 'This value is invalid.';
				return values[key] ?? '';
			}
		};
		values.workspaceName = validate('workspaceName', () =>
			validateWorkspaceName(values.workspaceName!),
		);
		values.workspaceSlug = validate('workspaceSlug', () =>
			validateWorkspaceSlug(values.workspaceSlug!),
		);
		values.ownerName = validate('ownerName', () =>
			validateDisplayName(values.ownerName!),
		);
		values.ownerEmail = validate('ownerEmail', () =>
			validateEmailAddress(values.ownerEmail!),
		);
		try {
			assertPasswordPolicy(password, base.passwordMinLength, values.ownerEmail);
		} catch (error) {
			fieldErrors.ownerPassword =
				error instanceof AuthServiceError
					? error.message
					: 'Choose a valid owner password.';
		}
		if (password !== passwordConfirm) {
			fieldErrors.ownerPasswordConfirm = 'Passwords do not match.';
		}
		try {
			validateApplicationPath(values.applicationPath!);
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
				(options.databasePreconfigured ||
					options.environment.FD_APPLICATION_PATH) &&
				values.applicationPath !== base.values.applicationPath
			) {
				fieldErrors.applicationPath =
					'This address is controlled by the deployment. Change FD_APPLICATION_PATH in its environment.';
			}
		} catch {
			fieldErrors.applicationPath =
				'Use one path such as /app or /backoffice (up to 64 characters, lowercase letters, digits and hyphens). System addresses are reserved.';
		}
		if (Object.keys(fieldErrors).length > 0) {
			return workspaceView(session, database, {
				values,
				fieldErrors,
				error: 'Some values need attention before you can continue.',
			});
		}
		const state: ReviewState = {
			...database,
			kind: 'review',
			values,
			owner: {
				workspaceName: values.workspaceName!,
				workspaceSlug: values.workspaceSlug!,
				ownerEmail: values.ownerEmail!,
				ownerName: values.ownerName!,
				ownerPassword: password,
			},
		};
		session.pending = state;
		return reviewView(session, state);
	};

	const apply = async (
		session: SetupSession,
		state: ReviewState,
	): Promise<Response> => {
		const adapter = options.adapters.get(state.adapterId);
		if (!options.databasePreconfigured && (!adapter || !state.input)) {
			return reviewView(session, state, 'That database is no longer offered.');
		}
		if (!options.databasePreconfigured && state.probe?.status !== 'ready') {
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
		if (applying) {
			return reviewView(
				session,
				state,
				'Setup is already being applied. Wait a moment, then reload this page.',
			);
		}
		const secrets = [
			...(state.input ? setupSecretValues(state.input) : []),
			state.owner.ownerPassword,
		];
		let seed: FirstRunSeed;
		applying = true;
		try {
			if (state.input) {
				await adapter!.descriptor.provision(state.input, {
					intent: 'confirmed-first-run',
				});
			}
			const provider = state.input
				? adapter!.openProvider(state.input)
				: createPlatformDatabaseProvider(
						databaseProviderConfigFromEnvironment(
							options.environment,
							options.workspaceRoot,
						),
					);
			try {
				await provider.check();
				const provision = () =>
					seedFirstRun(
						provider,
						options.environment,
						options.workspaceRoot,
						state.owner,
					);
				/* An embedded database is one connection inside this process, which
				   the in-process guard above already serializes. */
				seed =
					provider.adapter === 'postgresql'
						? await claimFirstRun(provider, provision)
						: await provision();
			} finally {
				await provider.dispose();
			}
		} catch (error) {
			if (
				error instanceof SetupSeedError ||
				error instanceof AuthServiceError
			) {
				return reviewView(session, state, error.message);
			}
			return reviewView(
				session,
				state,
				classifySetupFailure(error, secrets).message,
			);
		} finally {
			applying = false;
		}
		options.inPlace?.onClaimed();
		/* Configuration is stored last: an earlier failure leaves this deployment
		   exactly as it was, still unconfigured, still on this screen. */
		const done: DoneState = {
			kind: 'done',
			applicationPath: state.values.applicationPath!,
			seed,
			environment: state.input
				? writeEnvironmentFile(options.workspaceRoot, {
						...adapter!.environment(state.input),
						FD_APPLICATION_PATH: state.values.applicationPath!,
					})
				: null,
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
		if (state?.kind === 'done') {
			if (step === 'restart' && canAutoRestart(options, state)) {
				if (!restartScheduled) {
					restartScheduled = true;
					const exitCode =
						options.environment.FD_SETUP_RESTART_EXIT_CODE === '75' ? 75 : 0;
					if (options.restartApplication) options.restartApplication(exitCode);
					else setTimeout(() => process.exit(exitCode), 250).unref();
				}
				return new Response(null, {
					status: 204,
					headers: { 'cache-control': 'no-store' },
				});
			}
			return doneView(session, state);
		}
		if (step === 'back') {
			if (state?.kind === 'review') {
				const database: DatabaseState = {
					kind: 'database',
					adapterId: state.adapterId,
					input: state.input,
					values: state.values,
					probe: state.probe,
					modules: state.modules,
				};
				session.pending = database;
				return workspaceView(session, database);
			}
			if (state?.kind === 'database' && !options.databasePreconfigured) {
				session.pending = null;
				return configureView(session, {
					values: state.values,
					selectedAdapterId: state.adapterId,
				});
			}
			return render(context);
		}
		if (step === 'configure') return configure(session, form);
		if (step === 'workspace') return workspace(session, form);
		if (step === 'apply' && state?.kind === 'review') {
			return apply(session, state);
		}
		return render(context);
	};

	return async (context) =>
		context.request.method === 'POST' ? submit(context) : render(context);
}

export function createSetupRoutes(
	options: SetupRoutesOptions,
): readonly ServerRoute[] {
	/* While installation has no workspace, only setup and process health are
	   served. A configured database does not expose the application until its
	   first owner has completed the wizard. */
	return [
		new ServerRoute({
			path: '/setup',
			methods: ['GET', 'POST'],
			handler: createSetupHandler(options),
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
								'Complete the first-run setup at /setup before using the platform.',
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
