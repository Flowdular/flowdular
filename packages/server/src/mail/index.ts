export {
	acceptMailMessage,
	mailAddress,
	mailSender,
	MailError,
	MAIL_ADAPTERS,
	MAIL_LIMITS,
	NO_MAIL,
} from './contracts.ts';
export type {
	AcceptedMailMessage,
	DeliveredMail,
	MailAdapterId,
	MailErrorCode,
	MailMessage,
	MailPort,
} from './contracts.ts';
export { mailConfigFromEnvironment } from './config.ts';
export type { MailConfig, MailVariableNames } from './config.ts';
export { createMailPort, DEVELOPMENT_OUTBOX_LIMIT } from './port.ts';
export type { MailPortOptions } from './port.ts';
export { createSmtpMailAdapter, SmtpMailAdapter } from './smtp.ts';
export type {
	SmtpMailAdapterOptions,
	SmtpMessage,
	SmtpTransport,
	SmtpTransportFactory,
	SmtpTransportOptions,
} from './smtp.ts';
export { renderMailTemplate, MAIL_TEMPLATE_LIMITS } from './template.ts';
export type { MailTemplate, RenderedMailTemplate } from './template.ts';
