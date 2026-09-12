import { renderMailTemplate, type MailMessage } from '@flowdular/server';
import translationsEn from '../../translations/en.json' with { type: 'json' };
import translationsPl from '../../translations/pl.json' with { type: 'json' };
import type { AuthMailKind, AuthMailMessage } from './mail-delivery.ts';

/* What auth.core's three messages say, in every shipped locale. The wording
   lives here rather than in a transport, so the SMTP relay and the platform
   mail port send the same bytes. */

type MailBundle = Readonly<Record<string, string>>;

const FALLBACK_LOCALE = 'en';

const BUNDLES: Readonly<Record<string, MailBundle>> = {
	en: translationsEn,
	pl: translationsPl,
};

function resolveLocale(locale: string): string {
	return Object.hasOwn(BUNDLES, locale) ? locale : FALLBACK_LOCALE;
}

function wording(bundle: MailBundle, key: string): string {
	return bundle[key] ?? BUNDLES[FALLBACK_LOCALE]![key] ?? key;
}

/**
 * One auth.core message, rendered from the bundle of `locale`; an unknown
 * locale renders English and says so. The link is the only value that reaches
 * the body, and the template helper escapes it for the HTML part, so a URL can
 * never close the anchor it sits in.
 */
export function authMailMessage(
	message: AuthMailMessage,
	locale: string,
): MailMessage {
	const resolved = resolveLocale(locale);
	const bundle = BUNDLES[resolved]!;
	const kind: AuthMailKind = message.kind;
	const subject = wording(bundle, `mail.${kind}.subject`);
	const intro = wording(bundle, `mail.${kind}.intro`);
	const action = wording(bundle, `mail.${kind}.action`);
	const closing = wording(bundle, 'mail.closing');
	const rendered = renderMailTemplate(
		{
			subject,
			text: `${intro}\n\n{{url}}\n\n${closing}\n`,
			html: `<p>${intro}</p><p><a href="{{url}}">${action}</a></p><p>{{url}}</p><p>${closing}</p>`,
			locale: resolved,
		},
		{ url: message.url },
	);
	return { to: message.to, ...rendered };
}
