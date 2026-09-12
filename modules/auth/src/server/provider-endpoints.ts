import { ServerRoute } from '@octanejs/app-core';
import { readJsonObject } from '@flowdular/server';
import { AUTH_SCOPES } from '../acl/scopes.ts';
import type { IdentityProviderSummary } from '../domain/types.ts';
import type { IdentityProviderInput } from '../services/identity-provider-service.ts';
import {
	actorOf,
	errorResponse,
	requireScope,
	requireSession,
	response,
	stringField,
} from './http.ts';
import type { AuthRuntime, OidcProvider } from './runtime.ts';
import { sessionMutationDenial } from './session-security.ts';

const LABEL = '[auth.core] identity provider request failed';

/**
 * A provider the deployment configured in FD_AUTH_OIDC_PROVIDERS, as a
 * workspace sees it: present, never editable, and offered on the sign-in screen
 * only while the deployment lists it in FD_AUTH_SIGN_IN_PROVIDERS.
 */
export function platformProviderSummary(
	provider: OidcProvider,
	offered: boolean,
): IdentityProviderSummary {
	return {
		id: `platform:${provider.id}`,
		key: provider.id,
		label: provider.id,
		issuer: provider.issuer,
		clientId: provider.clientId,
		scopes: ['openid', 'email', 'profile'],
		jitEnabled: false,
		allowedDomains: [],
		jitRole: '',
		status: offered ? 'active' : 'disabled',
		/* The deployment secret is the same in every workspace, so a fingerprint
		   of it would be one value every workspace could compare against its own
		   guesses. A platform provider shows none; rotating it is an operator
		   action on FD_AUTH_OIDC_PROVIDERS, not a workspace one. */
		secretFingerprint: '',
		scope: 'platform',
		updatedAt: 0,
	};
}

export function platformProviders(
	runtime: AuthRuntime,
): readonly IdentityProviderSummary[] {
	const offered = new Set(runtime.settings.signInProviders);
	return runtime.oidcProviders.map((provider) =>
		platformProviderSummary(provider, offered.has(provider.id)),
	);
}

/* The administrator's input as it arrives. Every field is validated in the
   service, which owns the bounds and the stable codes; the body itself is
   already capped at 16 KB by readJsonObject. A field the body omits is left out
   here too, so the service can tell "not sent" from "sent empty": a create
   refuses the missing required ones and an update keeps what is stored. */
function providerInput(
	body: Record<string, unknown>,
	options: { readonly withKey: boolean },
): IdentityProviderInput {
	return {
		...(options.withKey ? { key: stringField(body, 'key') } : {}),
		...(body.label === undefined ? {} : { label: stringField(body, 'label') }),
		...(body.issuer === undefined
			? {}
			: { issuer: stringField(body, 'issuer') }),
		...(body.clientId === undefined
			? {}
			: { clientId: stringField(body, 'clientId') }),
		...(body.clientSecret === undefined
			? {}
			: { clientSecret: stringField(body, 'clientSecret') }),
		...(body.scopes === undefined ? {} : { scopes: body.scopes as string[] }),
		...(body.jitEnabled === undefined
			? {}
			: { jitEnabled: body.jitEnabled === true }),
		...(body.allowedDomains === undefined
			? {}
			: { allowedDomains: body.allowedDomains as string[] }),
		...(body.jitRole === undefined
			? {}
			: { jitRole: stringField(body, 'jitRole') }),
	};
}

export function createIdentityProviderRoutes(
	runtime: AuthRuntime,
): readonly ServerRoute[] {
	const list = new ServerRoute({
		path: '/api/auth/providers',
		methods: ['GET'],
		handler: async (context) => {
			try {
				const session = requireSession(context);
				requireScope(session, AUTH_SCOPES.providersRead);
				const owned = await (
					await runtime.service()
				).identityProviders.list(session.principal.tenantId);
				return response({
					providers: [...owned, ...platformProviders(runtime)],
				});
			} catch (error) {
				return errorResponse(error, LABEL);
			}
		},
	});

	const create = new ServerRoute({
		path: '/api/auth/providers',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context);
				requireScope(session, AUTH_SCOPES.providersManage);
				const body = await readJsonObject(context.request);
				return response(
					{
						provider: await (
							await runtime.service()
						).identityProviders.create(
							actorOf(session),
							providerInput(body, { withKey: true }),
						),
					},
					201,
				);
			} catch (error) {
				return errorResponse(error, LABEL);
			}
		},
	});

	const update = new ServerRoute({
		path: '/api/auth/providers/update',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context);
				requireScope(session, AUTH_SCOPES.providersManage);
				const body = await readJsonObject(context.request);
				return response({
					provider: await (
						await runtime.service()
					).identityProviders.update(
						actorOf(session),
						stringField(body, 'id'),
						providerInput(body, { withKey: false }),
					),
				});
			} catch (error) {
				return errorResponse(error, LABEL);
			}
		},
	});

	const status = (path: string, next: 'active' | 'disabled') =>
		new ServerRoute({
			path,
			methods: ['POST'],
			handler: async (context) => {
				const denial = sessionMutationDenial(context, runtime);
				if (denial) return denial;
				try {
					const session = requireSession(context);
					requireScope(session, AUTH_SCOPES.providersManage);
					const body = await readJsonObject(context.request);
					return response({
						provider: await (
							await runtime.service()
						).identityProviders.setStatus(
							actorOf(session),
							stringField(body, 'id'),
							next,
						),
					});
				} catch (error) {
					return errorResponse(error, LABEL);
				}
			},
		});

	const rotateSecret = new ServerRoute({
		path: '/api/auth/providers/rotate-secret',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context);
				requireScope(session, AUTH_SCOPES.providersManage);
				const body = await readJsonObject(context.request);
				return response({
					provider: await (
						await runtime.service()
					).identityProviders.rotateSecret(
						actorOf(session),
						stringField(body, 'id'),
						body.clientSecret,
					),
				});
			} catch (error) {
				return errorResponse(error, LABEL);
			}
		},
	});

	const remove = new ServerRoute({
		path: '/api/auth/providers/delete',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context);
				requireScope(session, AUTH_SCOPES.providersManage);
				const body = await readJsonObject(context.request);
				await (
					await runtime.service()
				).identityProviders.remove(actorOf(session), stringField(body, 'id'));
				return response({ deleted: true });
			} catch (error) {
				return errorResponse(error, LABEL);
			}
		},
	});

	return [
		list,
		create,
		update,
		status('/api/auth/providers/enable', 'active'),
		status('/api/auth/providers/disable', 'disabled'),
		rotateSecret,
		remove,
	];
}
