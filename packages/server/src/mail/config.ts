import { serverLogger } from '../log.ts';
import { MAIL_ADAPTERS, type MailAdapterId } from './contracts.ts';

/* Mail is configured by the process environment, the way storage and the
   database are, so a deployment never forks the platform composition to send a
   message. auth.core owned these variables before the port existed; its names
   are still read, once, with a deprecation warning naming the replacement. */

export interface MailVariableNames {
	readonly transport: string;
	readonly from: string;
	readonly url: string;
	readonly rejectUnauthorized: string;
	readonly requireTLS: string;
}

export interface MailConfig {
	readonly adapter: MailAdapterId;
	readonly production: boolean;
	/** `Name <address>` or an address. Empty unless the adapter is smtp. */
	readonly from: string;
	readonly smtp: {
		readonly url: string;
		readonly rejectUnauthorized: boolean;
		readonly requireTLS: boolean;
	};
	/**
	 * The variable each value was actually read from. Every refusal names one of
	 * these, so an operator reading the message finds the key they set.
	 */
	readonly variables: MailVariableNames;
	/** Deprecated names this environment still relies on, in the order read. */
	readonly deprecated: readonly string[];
}

const CANONICAL: MailVariableNames = {
	transport: 'FD_MAIL_TRANSPORT',
	from: 'FD_MAIL_FROM',
	url: 'FD_MAIL_SMTP_URL',
	rejectUnauthorized: 'FD_MAIL_SMTP_TLS_REJECT_UNAUTHORIZED',
	requireTLS: 'FD_MAIL_SMTP_REQUIRE_TLS',
};

const DEPRECATED: MailVariableNames = {
	transport: 'FD_AUTH_MAIL_TRANSPORT',
	from: 'FD_AUTH_MAIL_FROM',
	url: 'FD_AUTH_SMTP_URL',
	rejectUnauthorized: 'FD_AUTH_SMTP_TLS_REJECT_UNAUTHORIZED',
	requireTLS: 'FD_AUTH_SMTP_REQUIRE_TLS',
};

/** The boolean auth.core used before a transport could be named. */
const DEVELOPMENT_MAIL = 'FD_AUTH_DEVELOPMENT_MAIL';

/* One line per retired variable per process. An operator needs the notice once;
   a poll loop or a test that reads the environment repeatedly does not need it
   at every read. The set is bounded by the number of variables. */
const warned = new Set<string>();

function warnDeprecated(variable: string, replacement: string): void {
	if (warned.has(variable)) return;
	warned.add(variable);
	serverLogger().warn('deprecated mail variable', {
		module: 'mail',
		fields: { variable, replacement },
	});
}

interface ReadValue {
	readonly value: string;
	readonly variable: string;
}

function booleanValue(read: ReadValue, fallback: boolean): boolean {
	if (read.value === '') return fallback;
	if (read.value === 'true') return true;
	if (read.value === 'false') return false;
	throw new Error(`${read.variable} must be true or false.`);
}

function transportId(read: ReadValue): MailAdapterId {
	const found = MAIL_ADAPTERS.find((candidate) => candidate === read.value);
	if (!found) {
		throw new Error(
			`${read.variable} must be one of ${MAIL_ADAPTERS.join(', ')}.`,
		);
	}
	return found;
}

/**
 * The mail configuration of a deployment. Refuses the development adapter in
 * production here rather than at the first message, so a deployment that would
 * silently drop its mail never finishes booting.
 */
export function mailConfigFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): MailConfig {
	const production = environment.NODE_ENV === 'production';
	const deprecated: string[] = [];
	const variables: Record<keyof MailVariableNames, string> = { ...CANONICAL };

	/* Which family a refusal names for a variable nobody set: the one the
	   deployment is already editing, so an operator on the retired names is told
	   about the key next to the one they set rather than about a third spelling. */
	let missing: MailVariableNames = CANONICAL;

	const read = (key: keyof MailVariableNames): ReadValue => {
		const current = environment[CANONICAL[key]]?.trim() ?? '';
		if (current !== '') return { value: current, variable: CANONICAL[key] };
		const legacy = environment[DEPRECATED[key]]?.trim() ?? '';
		if (legacy === '') return { value: '', variable: missing[key] };
		variables[key] = DEPRECATED[key];
		deprecated.push(DEPRECATED[key]);
		warnDeprecated(DEPRECATED[key], CANONICAL[key]);
		return { value: legacy, variable: DEPRECATED[key] };
	};

	const configured = read('transport');
	if (configured.variable === DEPRECATED.transport) missing = DEPRECATED;
	const developmentMail = booleanValue(
		{
			value: environment[DEVELOPMENT_MAIL]?.trim() ?? '',
			variable: DEVELOPMENT_MAIL,
		},
		false,
	);
	if (developmentMail) {
		deprecated.push(DEVELOPMENT_MAIL);
		warnDeprecated(DEVELOPMENT_MAIL, `${CANONICAL.transport}=development`);
	}
	const adapter =
		configured.value !== ''
			? transportId(configured)
			: developmentMail
				? 'development'
				: 'none';
	if (developmentMail && adapter !== 'development') {
		throw new Error(
			`${DEVELOPMENT_MAIL} cannot be combined with ${configured.variable}=${adapter}.`,
		);
	}
	if (production && adapter === 'development') {
		/* The in-memory adapter accepts every message and delivers none. In
		   production that is silent data loss, not a convenience. */
		throw new Error(
			`${configured.value !== '' ? `${configured.variable}=development` : DEVELOPMENT_MAIL} is only allowed outside production.`,
		);
	}
	if (adapter !== 'smtp') {
		return {
			adapter,
			production,
			from: '',
			smtp: { url: '', rejectUnauthorized: true, requireTLS: true },
			variables: { ...variables },
			deprecated,
		};
	}
	const url = read('url');
	if (url.value === '') {
		throw new Error(
			`${url.variable} is required when ${configured.variable} is smtp.`,
		);
	}
	const from = read('from');
	if (from.value === '') {
		throw new Error(
			`${from.variable} is required when ${configured.variable} is smtp.`,
		);
	}
	return {
		adapter,
		production,
		from: from.value,
		smtp: {
			url: url.value,
			rejectUnauthorized: booleanValue(read('rejectUnauthorized'), true),
			requireTLS: booleanValue(read('requireTLS'), true),
		},
		variables: { ...variables },
		deprecated,
	};
}
