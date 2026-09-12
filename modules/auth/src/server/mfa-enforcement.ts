import type { Middleware } from '@octanejs/app-core';
import {
	ModuleSettingsError,
	type ModuleSettingsRuntime,
} from '@flowdular/kernel';
import { readJsonObject } from '@flowdular/server';
import {
	isTokenPrincipal,
	principalFromContext,
} from '../middleware/authentication.ts';
import type { AuthPrincipal } from '../domain/types.ts';
import type { AuthService } from '../services/auth-service.ts';
import type { AuthTenantSettings } from '../settings.ts';

export const MFA_ENROLMENT_REQUIRED = 'MFA_ENROLMENT_REQUIRED';
export const MFA_KEY_REQUIRED = 'MFA_KEY_REQUIRED';

const MFA_KEY_REQUIRED_MESSAGE =
	'Required multi-factor authentication needs a deployment MFA encryption key; none is configured.';

/* Routes an account still has to reach while it holds no second factor: the
   shell's own identity read, the enrolment exchange itself, the workspace
   settings that carry the requirement, and the ways out of the workspace.
   Everything else under /api answers with the enrolment problem; nothing
   outside /api is gated here, so the shell that carries the enrolment screen
   keeps loading. Module web surfaces are covered by mfaEnrolmentSatisfied in
   the composition's identity resolver instead. */
const ENROLMENT_PATHS: ReadonlySet<string> = new Set([
	/* Platform probes answer the same to everyone; a session cookie that happens
	   to ride along must not turn one into a workspace decision. */
	'/api/health',
	'/api/ready',
	'/api/auth/config',
	'/api/auth/session',
	'/api/auth/mfa/status',
	'/api/auth/mfa/enroll',
	'/api/auth/mfa/confirm',
	'/api/auth/mfa/challenge',
	'/api/auth/password',
	'/api/auth/switch-tenant',
	'/api/auth/sign-out',
	/* The requirement is a stored setting, and an owner who turned it on before
	   enrolling has to be able to read it and turn it off again. The read stays
	   open; the write is narrowed to that one setting below. Both routes still
	   demand the settings scopes and, for the write, a session and a CSRF
	   proof. */
	'/api/settings',
]);

const SETTINGS_UPDATE_PATH = '/api/settings/update';

/* The settings write is open only for the setting that reverses the hold, so
   an unenrolled owner cannot administer the rest of the workspace through the
   one route that has to stay reachable. The body is read from a clone under
   the bound the endpoint itself applies, leaving the handler an unconsumed
   request; an unreadable body targets nothing and stays held. */
async function targetsRequireMfa(request: Request): Promise<boolean> {
	try {
		const body = await readJsonObject(request.clone());
		return body.moduleId === 'auth.core' && body.key === 'requireMfa';
	} catch {
		return false;
	}
}

export interface MfaEnrolmentGate {
	/** Live auth.core settings of one workspace, after stored values landed. */
	tenantSettings(tenantId: string): Promise<AuthTenantSettings>;
	service(): Promise<Pick<AuthService, 'hasConfirmedMfa'>>;
}

/**
 * Whether a principal meets its workspace's enrolment requirement. A workspace
 * that does not require enrolment pays one read of a primed settings snapshot
 * and no query. Every surface that resolves an identity of its own, including
 * module web pages, answers this before it serves workspace data.
 */
export async function mfaEnrolmentSatisfied(
	gate: MfaEnrolmentGate,
	principal: AuthPrincipal,
): Promise<boolean> {
	const settings = await gate.tenantSettings(principal.tenantId);
	if (!settings.requireMfa) return true;
	return (await gate.service()).hasConfirmedMfa(principal.accountId);
}

/**
 * Holds a member of a workspace that requires multi-factor authentication at
 * enrolment. It runs after the principal is resolved, so it sees exactly what
 * an endpoint's identity resolver sees.
 */
export function createMfaEnrolmentMiddleware(
	gate: MfaEnrolmentGate,
): Middleware {
	return async (context, next) => {
		const principal = principalFromContext(context);
		if (!principal) return next();
		/* A machine credential cannot enrol anything, and its authority is
		   already the intersection of its recorded scopes with the live
		   membership. Holding it here would close the workspace to every
		   integration with no way out; browser sessions stay gated. */
		if (isTokenPrincipal(context)) return next();
		const path = context.url.pathname;
		if (!path.startsWith('/api/') || ENROLMENT_PATHS.has(path)) return next();
		if (await mfaEnrolmentSatisfied(gate, principal)) return next();
		if (
			path === SETTINGS_UPDATE_PATH &&
			(await targetsRequireMfa(context.request))
		) {
			return next();
		}
		return Response.json(
			{
				error: {
					code: MFA_ENROLMENT_REQUIRED,
					message:
						'This workspace requires multi-factor authentication. Enrol an authenticator to continue.',
				},
			},
			{ status: 403, headers: { 'cache-control': 'no-store' } },
		);
	};
}

/**
 * Refuses `auth.core.requireMfa` on a deployment that configured no MFA
 * encryption key, the way email confirmation is refused without a mail
 * transport. Without the key enrolment answers 503, so the requirement would
 * close every workspace API to every member with nothing left to undo it.
 */
export function guardMfaSettings(
	settings: ModuleSettingsRuntime,
	mfaKeyConfigured: boolean,
): ModuleSettingsRuntime {
	if (mfaKeyConfigured) return settings;
	return {
		declare: (declaration) => settings.declare(declaration),
		declarations: () => settings.declarations(),
		get: (tenantId, moduleId, key) => settings.get(tenantId, moduleId, key),
		list: (tenantId) => settings.list(tenantId),
		set(tenantId, moduleId, key, value, actor) {
			if (moduleId === 'auth.core' && key === 'requireMfa' && value === true) {
				throw new ModuleSettingsError(
					MFA_KEY_REQUIRED,
					MFA_KEY_REQUIRED_MESSAGE,
					409,
				);
			}
			settings.set(tenantId, moduleId, key, value, actor);
		},
		onChange: (listener) => settings.onChange(listener),
	};
}
