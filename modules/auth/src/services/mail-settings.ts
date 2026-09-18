import { createHash } from 'node:crypto';
import {
	ModuleSettingsError,
	PLATFORM_SETTINGS_TENANT,
	type ModuleSettingsRuntime,
	type ModuleSettingValue,
} from '@flowdular/kernel';
import {
	createSmtpMailAdapter,
	mailSender,
	MailError,
	NO_MAIL,
	type DeliveredMail,
	type MailAdapterId,
	type MailMessage,
	type MailPort,
	type SmtpTransportFactory,
} from '@flowdular/server';
import { nodemailerSmtpTransport } from './mail-smtp.ts';
export {
	MAIL_TRANSPORT_OPTIONS,
	type MailTransportSetting,
} from '../settings.ts';

/* The relay an installation sends through is a stored platform setting, so an
   operator changes it in Administration without a deployment. The environment
   keeps its meaning: with nothing stored, FD_MAIL_* is the transport, exactly
   as before this existed. */

export const MAIL_SETTING_KEYS = {
	transport: 'mailTransport',
	from: 'mailFrom',
	url: 'mailSmtpUrl',
	requireTls: 'mailRequireTls',
	rejectUnauthorized: 'mailRejectUnauthorized',
} as const;

/* Names the refusals carry. They are settings, so an operator reading one finds
   the field on the screen rather than a variable they never set. */
const FIELDS = {
	transport: 'auth.core.mailTransport',
	from: 'auth.core.mailFrom',
	url: 'auth.core.mailSmtpUrl',
} as const;

export interface StoredMailConfiguration {
	readonly transport: 'none' | 'smtp';
	readonly from: string;
	readonly url: string;
	readonly requireTLS: boolean;
	readonly rejectUnauthorized: boolean;
}

/** What an operator is told is in effect, with nothing the relay owns in it. */
export interface EffectiveMailSummary {
	readonly source: 'settings' | 'environment';
	readonly transport: MailAdapterId;
	readonly configured: boolean;
	/** Sender the effective transport stamps; empty unless it is smtp. */
	readonly from: string;
}

function settingValue(
	settings: ModuleSettingsRuntime,
	key: string,
): ModuleSettingValue {
	return settings.get(PLATFORM_SETTINGS_TENANT, 'auth.core', key);
}

/**
 * The stored relay, or null while the settings name none and the deployment's
 * environment decides. Requires the platform settings snapshot to be primed.
 */
export function storedMailConfiguration(
	settings: ModuleSettingsRuntime,
): StoredMailConfiguration | null {
	const transport = settingValue(settings, MAIL_SETTING_KEYS.transport);
	if (transport !== 'none' && transport !== 'smtp') return null;
	return {
		transport,
		from: String(settingValue(settings, MAIL_SETTING_KEYS.from)),
		url: String(settingValue(settings, MAIL_SETTING_KEYS.url)),
		requireTLS: settingValue(settings, MAIL_SETTING_KEYS.requireTls) === true,
		rejectUnauthorized:
			settingValue(settings, MAIL_SETTING_KEYS.rejectUnauthorized) === true,
	};
}

/* Identifies one built transport without retaining what built it: the URL holds
   the relay password, so the cache is keyed by a hash of the configuration and
   never by the configuration itself. */
function configurationDigest(configuration: StoredMailConfiguration): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				configuration.transport,
				configuration.from,
				configuration.url,
				configuration.requireTLS,
				configuration.rejectUnauthorized,
			]),
		)
		.digest('hex');
}

function unconfigured(message: string): MailPort {
	return {
		adapter: 'none',
		configured: false,
		outbox: NO_MAIL,
		send: () => Promise.reject(new MailError('MAIL_NOT_CONFIGURED', message)),
	};
}

const NO_TRANSPORT = unconfigured(
	'No mail transport is configured for this deployment.',
);

const STORED_NONE = unconfigured(
	'The mail transport setting is none; no message is sent.',
);

function storedMailPort(
	configuration: StoredMailConfiguration,
	createTransport: SmtpTransportFactory,
): MailPort {
	if (configuration.transport === 'none') return STORED_NONE;
	const adapter = createSmtpMailAdapter({
		url: configuration.url,
		from: configuration.from,
		rejectUnauthorized: configuration.rejectUnauthorized,
		requireTLS: configuration.requireTLS,
		createTransport,
		variables: { url: FIELDS.url, from: FIELDS.from },
	});
	return {
		adapter: 'smtp',
		configured: true,
		outbox: NO_MAIL,
		send: (message) => adapter.send(message),
	};
}

export interface EffectiveMailPortOptions {
	readonly settings: ModuleSettingsRuntime;
	/** The deployment's FD_MAIL_* port; used while the settings name no transport. */
	readonly environment?: MailPort;
	/** Opens the relay of a stored configuration; tests pass their own. */
	readonly createSmtpTransport?: SmtpTransportFactory;
}

export interface EffectiveMailPort extends MailPort {
	/** What is in effect right now, for a screen and for an audit row. */
	summary(): EffectiveMailSummary;
}

/**
 * The port every sender of this installation uses. It resolves the stored
 * configuration on each message rather than at boot, so a relay changed a
 * minute ago is the one the next message takes, and caches the built transport
 * by a digest of that configuration so an unchanged relay is opened once.
 */
export function createEffectiveMailPort(
	options: EffectiveMailPortOptions,
): EffectiveMailPort {
	const createTransport =
		options.createSmtpTransport ?? nodemailerSmtpTransport;
	const environment = options.environment;
	let cached: { readonly digest: string; readonly port: MailPort } | undefined;

	/* Best effort: the sync members answer before the platform snapshot is
	   primed, and an unprimed read is the environment's answer rather than a
	   throw on a property. send() primes first, so a message never reads this. */
	const stored = (): StoredMailConfiguration | null => {
		try {
			return storedMailConfiguration(options.settings);
		} catch {
			return null;
		}
	};
	const portFor = (configuration: StoredMailConfiguration): MailPort => {
		const digest = configurationDigest(configuration);
		if (cached?.digest === digest) return cached.port;
		const port = storedMailPort(configuration, createTransport);
		cached = { digest, port };
		return port;
	};
	const effective = (
		configuration: StoredMailConfiguration | null,
	): MailPort =>
		configuration ? portFor(configuration) : (environment ?? NO_TRANSPORT);

	return {
		get adapter(): MailAdapterId {
			const configuration = stored();
			return configuration
				? configuration.transport
				: (environment?.adapter ?? 'none');
		},
		get configured(): boolean {
			const configuration = stored();
			return configuration
				? configuration.transport === 'smtp'
				: (environment?.configured ?? false);
		},
		get outbox(): readonly DeliveredMail[] {
			return stored() ? NO_MAIL : (environment?.outbox ?? NO_MAIL);
		},
		summary(): EffectiveMailSummary {
			const configuration = stored();
			if (configuration) {
				return {
					source: 'settings',
					transport: configuration.transport,
					configured: configuration.transport === 'smtp',
					from: configuration.transport === 'smtp' ? configuration.from : '',
				};
			}
			return {
				source: 'environment',
				transport: environment?.adapter ?? 'none',
				configured: environment?.configured ?? false,
				from: '',
			};
		},
		async send(message: MailMessage): Promise<void> {
			await options.settings.prime(PLATFORM_SETTINGS_TENANT);
			await effective(storedMailConfiguration(options.settings)).send(message);
		},
	};
}

function refuse(code: string, message: string): ModuleSettingsError {
	return new ModuleSettingsError(code, message, 400);
}

/**
 * `smtp://` or `smtps://` with a host. The thrown value never carries the URL:
 * it holds the relay password.
 */
function assertRelayUrl(value: string): void {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw refuse('INVALID_SETTING_VALUE', `${FIELDS.url} must be a valid URL.`);
	}
	if (parsed.protocol !== 'smtp:' && parsed.protocol !== 'smtps:') {
		throw refuse(
			'INVALID_SETTING_VALUE',
			`${FIELDS.url} must use smtp:// or smtps://.`,
		);
	}
	if (!parsed.hostname) {
		throw refuse('INVALID_SETTING_VALUE', `${FIELDS.url} must name a host.`);
	}
	try {
		decodeURIComponent(parsed.username);
		decodeURIComponent(parsed.password);
	} catch {
		/* A stray percent only fails when the adapter opens the relay, which is
		   the next invitation rather than this Save. */
		throw refuse(
			'INVALID_SETTING_VALUE',
			`${FIELDS.url} credentials must be percent-encoded.`,
		);
	}
}

function assertSenderAddress(value: string): void {
	try {
		mailSender(value, FIELDS.from);
	} catch (error) {
		throw refuse(
			'INVALID_SETTING_VALUE',
			error instanceof MailError
				? error.message
				: `${FIELDS.from} must be an address or "Name <address>".`,
		);
	}
}

/**
 * Refuses a mail configuration that would only fail at the next invitation: an
 * unusable relay URL or sender, and the `smtp` transport without either. The
 * write is checked against the configuration it would leave behind, so clearing
 * the URL of a live relay is refused exactly as naming smtp without one is.
 */
export function assertMailSettingWrite(
	settings: ModuleSettingsRuntime,
	key: string,
	value: ModuleSettingValue | null,
): void {
	const current = (target: string): string =>
		String(settingValue(settings, target));
	const next = (target: string): string =>
		key === target ? (value === null ? '' : String(value)) : current(target);
	if (key === MAIL_SETTING_KEYS.url && value !== null && value !== '') {
		assertRelayUrl(String(value));
	}
	if (key === MAIL_SETTING_KEYS.from && value !== null && value !== '') {
		assertSenderAddress(String(value));
	}
	const transport =
		key === MAIL_SETTING_KEYS.transport
			? value === null
				? 'environment'
				: String(value)
			: current(MAIL_SETTING_KEYS.transport);
	if (transport !== 'smtp') return;
	if (next(MAIL_SETTING_KEYS.url) === '') {
		throw refuse(
			'MAIL_RELAY_INCOMPLETE',
			`${FIELDS.transport} smtp needs ${FIELDS.url}; none is stored.`,
		);
	}
	if (next(MAIL_SETTING_KEYS.from) === '') {
		throw refuse(
			'MAIL_RELAY_INCOMPLETE',
			`${FIELDS.transport} smtp needs ${FIELDS.from}; none is stored.`,
		);
	}
}

const MAIL_KEYS: ReadonlySet<string> = new Set(
	Object.values(MAIL_SETTING_KEYS),
);

/**
 * Holds the mail settings to a configuration that can actually send, so an
 * operator learns what is missing at the Save rather than at the next
 * invitation. Every refusal names the field and carries none of its value.
 */
export function guardMailSettings(
	settings: ModuleSettingsRuntime,
): ModuleSettingsRuntime {
	return {
		declare: (declaration) => settings.declare(declaration),
		declarations: () => settings.declarations(),
		prime: (tenantId) => settings.prime(tenantId),
		get: (tenantId, moduleId, key) => settings.get(tenantId, moduleId, key),
		list: (tenantId) => settings.list(tenantId),
		async set(tenantId, moduleId, key, value, actor) {
			if (moduleId === 'auth.core' && MAIL_KEYS.has(key)) {
				/* The rule reads the other four values, so the snapshot they live in
				   has to be loaded before the write is judged. */
				await settings.prime(PLATFORM_SETTINGS_TENANT);
				assertMailSettingWrite(settings, key, value);
			}
			await settings.set(tenantId, moduleId, key, value, actor);
		},
		onChange: (listener) => settings.onChange(listener),
	};
}
