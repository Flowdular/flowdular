import { ServerRoute } from '@octanejs/app-core';
import { MailError } from '@flowdular/server';
import { PLATFORM_SCOPES } from '../acl/scopes.ts';
import { AttemptLimiter } from '../api/attempt-limiter.ts';
import { AuthServiceError } from '../services/auth-service-error.ts';
import {
	actorOf,
	errorResponse,
	requireScope,
	requireSession,
	response,
} from './http.ts';
import type { AuthRuntime } from './runtime.ts';
import { sessionMutationDenial } from './session-security.ts';

const LABEL = '[auth.core] mail request failed';

/* A test message costs a relay connection and an outbound mail, and the button
   that sends it sits on a screen an owner keeps open. Three per owner per
   quarter hour is enough to configure a relay and too few to be a sender. */
const testAttempts = new AttemptLimiter(3, 15 * 60 * 1000);

const SUBJECT = 'Flowdular mail test';
const BODY = [
	'This is the test message the Flowdular mail settings screen sends.',
	'Receiving it means the configured relay accepted a message for your address.',
].join('\n\n');

/**
 * The mail relay of the installation as an operator sees it. It names the
 * transport, the sender and which source decided them, and never the relay
 * address or anything that authenticates to it.
 */
export function createMailRoutes(runtime: AuthRuntime): readonly ServerRoute[] {
	const status = new ServerRoute({
		path: '/api/auth/mail',
		methods: ['GET'],
		handler: async (context) => {
			try {
				const session = requireSession(context);
				requireScope(session, PLATFORM_SCOPES.settingsRead);
				return response({ mail: runtime.mail.summary() });
			} catch (error) {
				return errorResponse(error, LABEL);
			}
		},
	});

	const test = new ServerRoute({
		path: '/api/auth/mail/test',
		methods: ['POST'],
		handler: async (context) => {
			const denial = sessionMutationDenial(context, runtime);
			if (denial) return denial;
			try {
				const session = requireSession(context);
				requireScope(session, PLATFORM_SCOPES.settingsManage);
				/* The recipient is the signed-in address and is never read from the
				   request: the button proves a relay works, it does not address
				   mail. */
				const to = session.principal.email;
				if (
					!testAttempts.consume(
						`mail-test:${session.principal.tenantId}:${session.principal.accountId}`,
					)
				) {
					throw new AuthServiceError(
						'RATE_LIMITED',
						'Too many test messages. Try again later.',
						429,
					);
				}
				const service = await runtime.service();
				const summary = runtime.mail.summary();
				try {
					await runtime.mail.send({ to, subject: SUBJECT, text: BODY });
				} catch (error) {
					/* Only the port's own words travel. They never include the relay
					   banner, the host or the credentials, and the port turns an
					   unusable stored configuration into one of them too. Anything
					   else is unexpected and says nothing about the relay. */
					const mailError = error instanceof MailError ? error : null;
					const code = mailError?.code ?? 'MAIL_DELIVERY_FAILED';
					const message =
						mailError?.message ?? 'The mail transport refused the message.';
					await service.recordMailTest(actorOf(session), {
						source: summary.source,
						transport: summary.transport,
						outcome: code,
					});
					return response({ error: { code, message } }, 502);
				}
				await service.recordMailTest(actorOf(session), {
					source: summary.source,
					transport: summary.transport,
					outcome: 'sent',
				});
				return response({ sent: true, mail: runtime.mail.summary() });
			} catch (error) {
				return errorResponse(error, LABEL);
			}
		},
	});

	return [status, test];
}
