/* A coding agent process inherits the operator's shell by default, so anything
   exported there (DATABASE_URL, a platform token, a cloud credential) is
   readable by a model and by anything it runs. The delivery runner and the
   preview worker already build an explicit environment; the agent drivers get
   the same treatment here, and an allowlist is the default rather than the
   opt-in. */
const INHERITED_KEYS = new Set([
	'HOME',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'LOGNAME',
	'PATH',
	'SHELL',
	'SYSTEMROOT',
	'TEMP',
	'TMP',
	'TMPDIR',
	'USER',
	'XDG_CACHE_HOME',
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_STATE_HOME',
	'XDG_RUNTIME_DIR',
	'NODE_OPTIONS',
]);

/* Provider credentials are the one thing a driver genuinely cannot work
   without. Each entry is scoped to the driver that needs it, so a codex turn
   never carries an Anthropic key and neither carries a database URL. */
const DRIVER_KEYS: Readonly<Record<string, readonly string[]>> = {
	'claude-code': [
		'ANTHROPIC_API_KEY',
		'ANTHROPIC_AUTH_TOKEN',
		'ANTHROPIC_BASE_URL',
		'ANTHROPIC_CUSTOM_HEADERS',
		'ANTHROPIC_MODEL',
		'ANTHROPIC_DEFAULT_HAIKU_MODEL',
		'ANTHROPIC_DEFAULT_SONNET_MODEL',
		'ANTHROPIC_DEFAULT_OPUS_MODEL',
		'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
		'CLAUDE_CODE_USE_BEDROCK',
		'CLAUDE_CODE_USE_VERTEX',
		'CLAUDE_CODE_USE_FOUNDRY',
	],
	codex: [
		'CODEX_API_KEY',
		'CODEX_BASE_URL',
		'OPENAI_API_KEY',
		'OPENAI_BASE_URL',
		'OPENAI_ORGANIZATION',
		'OPENAI_PROJECT',
		'OPENAI_MODEL',
	],
};

/* Names that must never reach a driver even when an operator exports them
   globally, because a session turns them into production access. */
const REFUSED_KEYS = [
	/^DATABASE_URL$/i,
	/^PG(?:PASSFILE|PASSWORD|SERVICE|HOST|PORT|USER)?$/i,
	/^FD_[A-Z0-9_]*TOKEN$/i,
	/^GH_TOKEN$/i,
	/^GITHUB_TOKEN$/i,
	/^AWS_[A-Z0-9_]*(?:SECRET|TOKEN|SESSION)/i,
	/^AZURE_[A-Z0-9_]*KEY$/i,
	/^GCP_[A-Z0-9_]*KEY$/i,
	/^NPM_TOKEN$/i,
	/^[A-Z0-9_]*(?:PASSWORD|SECRET|PRIVATE_KEY)$/i,
];

function isRefused(name: string): boolean {
	return REFUSED_KEYS.some((pattern) => pattern.test(name));
}

function assign(
	target: NodeJS.ProcessEnv,
	source: NodeJS.ProcessEnv,
	name: string,
): void {
	const value = source[name];
	if (value === undefined || value === '' || isRefused(name)) return;
	target[name] = value;
}

/* An agent needs PATH, HOME and its own provider key. It does not need the
   operator's database, object store or platform credentials. */
export function agentEnvironment(
	driver: string,
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of INHERITED_KEYS) assign(env, source, name);
	for (const name of DRIVER_KEYS[driver] ?? []) assign(env, source, name);
	return env;
}

/* A version probe only has to find and run the binary, so it needs PATH and
   HOME and nothing else. */
export function probeEnvironment(
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of ['HOME', 'LANG', 'PATH', 'SHELL', 'TMPDIR', 'USER'])
		assign(env, source, name);
	return env;
}

/* Names an operator has exported that this function deliberately drops. The
   sandbox surfaces them in the turn transcript so a silent drop is visible. */
export function withheldEnvironmentKeys(
	driver: string,
	source: NodeJS.ProcessEnv = process.env,
): readonly string[] {
	return Object.keys(source)
		.filter((name) => !agentEnvironment(driver, source)[name])
		.filter(
			(name) =>
				isRefused(name) || /TOKEN|SECRET|PASSWORD|KEY|DATABASE_URL/i.test(name),
		)
		.sort();
}
