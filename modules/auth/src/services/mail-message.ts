import { renderMailTemplate, type MailMessage } from '@flowdular/server';
import type { AuthMailKind, AuthMailMessage } from './mail-delivery.ts';

/* What auth.core's three messages say. The wording lives here rather than in a
   transport, so the SMTP relay and the platform mail port send the same bytes. */

interface AuthMailTemplate {
	readonly subject: string;
	readonly intro: string;
	readonly action: string;
}

const TEMPLATES: Record<AuthMailKind, AuthMailTemplate> = {
	'password-reset': {
		subject: 'Reset your password',
		intro:
			'A password reset was requested for this address. Open the link below to choose a new password.',
		action: 'Reset your password',
	},
	'tenant-invitation': {
		subject: 'You have been invited to a workspace',
		intro:
			'You have been invited to a workspace. Open the link below to accept the invitation and set up your account.',
		action: 'Accept the invitation',
	},
	'email-confirmation': {
		subject: 'Confirm your email address',
		intro:
			'Confirm this address to finish setting up your account. Open the link below to complete the confirmation.',
		action: 'Confirm your address',
	},
};

const CLOSING =
	'The link expires and can be used only once. If you did not expect this message, you can ignore it.';

/* The wording above is English, so every message says so and a client renders
   it as English. Choosing the wording by the recipient's own locale is out of
   scope in this module's specification. */
const LOCALE = 'en';

/**
 * One auth.core message, rendered. The link is the only value that reaches the
 * body, and the template helper escapes it for the HTML part, so a URL can
 * never close the anchor it sits in.
 */
export function authMailMessage(message: AuthMailMessage): MailMessage {
	const template = TEMPLATES[message.kind];
	const rendered = renderMailTemplate(
		{
			subject: template.subject,
			text: `${template.intro}\n\n{{url}}\n\n${CLOSING}\n`,
			html: `<p>${template.intro}</p><p><a href="{{url}}">${template.action}</a></p><p>{{url}}</p><p>${CLOSING}</p>`,
			locale: LOCALE,
		},
		{ url: message.url },
	);
	return { to: message.to, ...rendered };
}
