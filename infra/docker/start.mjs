#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const directory = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(directory, '.env');
const examplePath = resolve(directory, '.env.example');
const composePath = resolve(directory, 'compose.yaml');
const projectRoot = resolve(directory, '../..');

const databasePasswords = [
	'FD_POSTGRES_SUPERUSER_PASSWORD',
	'FD_DATABASE_MIGRATOR_PASSWORD',
	'FD_DATABASE_RUNTIME_PASSWORD',
	'FD_DATABASE_BACKGROUND_PASSWORD',
];
const encryptionKeys = [
	'FD_AGENT_CREDENTIAL_KEY',
	'FD_AGENT_RUN_GRANT_KEY',
	'FD_AUTH_MFA_KEY',
	'FD_APPROVAL_GRANT_KEY',
	'FD_AUTOMATIONS_CREDENTIAL_KEY',
	'FD_NOTIFICATIONS_SECRET_KEY',
	'FD_WORKFLOWS_PAYLOAD_KEY',
	'FD_WORKFLOWS_CURSOR_KEY',
	'FD_STORAGE_ENCRYPTION_KEY',
	'FD_CONNECTORS_SECRET_KEY',
	'FD_AUDIT_ANCHOR_KEY',
];
const secretKeys = [
	...databasePasswords,
	...encryptionKeys,
	'FD_MINIO_ROOT_PASSWORD',
];
const plainEnvValue = /^[A-Za-z0-9_./+=:@%~-]+$/;

function setEntry(contents, key, value) {
	const line = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=)[^\\r\\n]*$`, 'm');
	if (line.test(contents)) {
		return contents.replace(line, (_match, prefix) => `${prefix}${value}`);
	}
	return `${contents.replace(/\s*$/, '\n')}${key}=${value}\n`;
}

function writePrivateFile(path, contents) {
	const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
	let handle;
	try {
		handle = openSync(temporary, 'wx', 0o600);
		writeFileSync(handle, contents);
		fsyncSync(handle);
		closeSync(handle);
		handle = undefined;
		renameSync(temporary, path);
		chmodSync(path, 0o600);
	} catch (error) {
		if (handle !== undefined) closeSync(handle);
		rmSync(temporary, { force: true });
		throw error;
	}
}

function valueOf(parsed, environment, key) {
	const fromFile = parsed[key] ?? '';
	const fromEnvironment = environment[key] ?? '';
	if (fromFile && fromEnvironment && fromFile !== fromEnvironment) {
		throw new Error(
			`${key} differs between the shell and infra/docker/.env. Use one value before starting.`,
		);
	}
	return fromEnvironment || fromFile;
}

function settingOf(parsed, environment, key) {
	return environment[key]?.trim() || parsed[key]?.trim() || '';
}

/** Fill only absent credentials. A restart must reuse exactly the same values. */
function ensureEnvironmentFileUnlocked(
	path = envPath,
	template = examplePath,
	environment = process.env,
) {
	const existed = existsSync(path);
	if (existed) {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error('infra/docker/.env must be a regular file, not a link.');
		}
	}
	let contents = existed
		? readFileSync(path, 'utf8')
		: readFileSync(template, 'utf8');
	let parsed = parseEnv(contents);
	let generated = 0;
	const fileProjectName = parsed.COMPOSE_PROJECT_NAME?.trim() ?? '';
	const shellProjectName = environment.COMPOSE_PROJECT_NAME?.trim() ?? '';
	if (
		fileProjectName &&
		shellProjectName &&
		fileProjectName !== shellProjectName
	) {
		throw new Error(
			'COMPOSE_PROJECT_NAME differs between the shell and infra/docker/.env. Use the existing project name to keep its volumes.',
		);
	}
	/* Earlier stacks used Compose's implicit name, docker. Persist it for old
	   .env files so upgrading cannot silently switch to empty volumes. */
	const projectName =
		fileProjectName ||
		shellProjectName ||
		(existed ? 'docker' : `flowdular-${randomBytes(6).toString('hex')}`);
	if (!/^[a-z0-9][a-z0-9_-]*$/.test(projectName)) {
		throw new Error(
			'COMPOSE_PROJECT_NAME must start with a lowercase letter or digit and contain only lowercase letters, digits, underscores or hyphens.',
		);
	}
	if (!fileProjectName) {
		contents = setEntry(contents, 'COMPOSE_PROJECT_NAME', projectName);
		parsed = { ...parsed, COMPOSE_PROJECT_NAME: projectName };
		generated++;
	}
	const port = settingOf(parsed, environment, 'FD_PORT') || '3000';
	if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
		throw new Error('FD_PORT must be an integer from 1 to 65535.');
	}
	const appPath =
		settingOf(parsed, environment, 'FD_APPLICATION_PATH') || '/app';
	if (
		appPath.length > 64 ||
		!/^\/[a-z][a-z0-9-]*$/.test(appPath) ||
		[
			'setup',
			'health',
			'ready',
			'assets',
			'auth',
			'api',
			'sites',
			'sign-in',
			'sign-up',
			'forgot-password',
			'reset-password',
			'accept-invitation',
		].includes(appPath.slice(1))
	) {
		throw new Error(
			'FD_APPLICATION_PATH must be one available path such as /app or /backoffice.',
		);
	}
	const bindAddress =
		settingOf(parsed, environment, 'FD_BIND_ADDRESS') || '127.0.0.1';
	if (isIP(bindAddress) !== 4) {
		throw new Error('FD_BIND_ADDRESS must be an IPv4 address.');
	}
	const origin =
		settingOf(parsed, environment, 'FD_AUTH_PUBLIC_ORIGIN') ||
		`http://localhost:${port}`;
	const localhostHttp =
		/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(origin);
	const cookieSetting = settingOf(parsed, environment, 'FD_AUTH_SECURE_COOKIE');
	if (localhostHttp && cookieSetting === 'true') {
		throw new Error(
			'FD_AUTH_SECURE_COOKIE=true blocks setup on local HTTP. Set it to false in infra/docker/.env or use an HTTPS origin.',
		);
	}
	const endpoint = settingOf(parsed, environment, 'FD_STORAGE_S3_ENDPOINT');
	const accessKey = settingOf(
		parsed,
		environment,
		'FD_STORAGE_S3_ACCESS_KEY_ID',
	);
	const secretKey = settingOf(
		parsed,
		environment,
		'FD_STORAGE_S3_SECRET_ACCESS_KEY',
	);
	/* An empty endpoint with AWS credentials is the existing AWS configuration.
	   New local installs receive an explicit MinIO endpoint in their .env. */
	const localMinio =
		endpoint === 'http://minio:9000' || (!endpoint && !accessKey && !secretKey);
	if (
		localMinio &&
		settingOf(parsed, environment, 'FD_STORAGE_S3_FORCE_PATH_STYLE') === 'false'
	) {
		throw new Error(
			'FD_STORAGE_S3_FORCE_PATH_STYLE must be true when using the bundled MinIO service.',
		);
	}
	if (!localMinio && (!accessKey || !secretKey)) {
		throw new Error(
			'An external S3 service needs FD_STORAGE_S3_ACCESS_KEY_ID and FD_STORAGE_S3_SECRET_ACCESS_KEY.',
		);
	}
	if (localMinio && !endpoint) {
		contents = setEntry(
			contents,
			'FD_STORAGE_S3_ENDPOINT',
			'http://minio:9000',
		);
		parsed = { ...parsed, FD_STORAGE_S3_ENDPOINT: 'http://minio:9000' };
		generated++;
	}
	for (const key of secretKeys) {
		const present = Boolean(parsed[key]);
		const value =
			valueOf(parsed, environment, key) ||
			(databasePasswords.includes(key) || key === 'FD_MINIO_ROOT_PASSWORD'
				? randomBytes(32).toString('hex')
				: randomBytes(32).toString('base64'));
		if (!present && !plainEnvValue.test(value)) {
			throw new Error(
				`${key} contains characters that this launcher cannot safely persist. Put it in infra/docker/.env directly.`,
			);
		}
		if (!present) {
			contents = setEntry(contents, key, value);
			parsed = { ...parsed, [key]: value };
			generated++;
		}
	}
	if (!cookieSetting) {
		contents = setEntry(
			contents,
			'FD_AUTH_SECURE_COOKIE',
			localhostHttp ? 'false' : 'true',
		);
		generated++;
	}
	if (!existsSync(path) || contents !== readFileSync(path, 'utf8'))
		writePrivateFile(path, contents);
	else chmodSync(path, 0o600);
	return {
		path,
		projectName,
		port: Number(port),
		appPath,
		bindAddress,
		publicOrigin: origin.replace(/\/+$/, ''),
		generated,
	};
}

export function ensureEnvironmentFile(
	path = envPath,
	template = examplePath,
	environment = process.env,
) {
	/* The lock covers reads, generated values and the atomic rename. Without it,
	   concurrent launchers can initialize PostgreSQL with a password that loses
	   the last rename and can no longer be recovered from .env. */
	const lockPath = `${path}.lock`;
	let lock;
	try {
		lock = openSync(lockPath, 'wx', 0o600);
	} catch (error) {
		if (error?.code === 'EEXIST') {
			throw new Error(
				'Another launcher is preparing infra/docker/.env. Wait for it to finish. If it crashed, verify no launcher is running before removing infra/docker/.env.lock.',
			);
		}
		throw error;
	}
	try {
		return ensureEnvironmentFileUnlocked(path, template, environment);
	} finally {
		closeSync(lock);
		rmSync(lockPath, { force: true });
	}
}

function compose(args, options = {}) {
	const result = spawnSync(
		'docker',
		['compose', '--env-file', envPath, '-f', composePath, ...args],
		{
			cwd: projectRoot,
			encoding: 'utf8',
			stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`docker compose ${args[0]} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}.`,
		);
	}
	return result.stdout ?? '';
}

async function waitForHealth(origin) {
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			const response = await fetch(`${origin}/api/health`, {
				signal: AbortSignal.timeout(3000),
			});
			if (response.ok) return;
		} catch {
			// Compose may have started the container before the port is listening.
		}
		await new Promise((done) => setTimeout(done, 2000));
	}
	throw new Error(
		`The application did not become healthy at ${origin}/api/health.`,
	);
}

function openBrowser(url) {
	if (
		process.platform === 'linux' &&
		!process.env.DISPLAY &&
		!process.env.WAYLAND_DISPLAY
	)
		return false;
	const command =
		process.platform === 'darwin'
			? 'open'
			: process.platform === 'win32'
				? 'rundll32.exe'
				: 'xdg-open';
	const args =
		process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
	const result = spawnSync(command, args, { stdio: 'ignore', timeout: 10000 });
	return !result.error && result.status === 0;
}

async function main() {
	const flags = new Set(process.argv.slice(2));
	if (flags.has('--help')) {
		console.log('Usage: node infra/docker/start.mjs [--no-open] [--no-build]');
		return;
	}
	for (const flag of flags) {
		if (!['--no-open', '--no-build'].includes(flag))
			throw new Error(`Unknown option: ${flag}`);
	}
	const version = spawnSync('docker', ['compose', 'version'], {
		stdio: 'ignore',
	});
	if (version.error || version.status !== 0)
		throw new Error('Docker Compose is required.');
	const { port, appPath, bindAddress, publicOrigin, generated } =
		ensureEnvironmentFile();
	console.log(
		generated
			? 'Saved first-run credentials in infra/docker/.env (owner-only).'
			: 'Using existing infra/docker/.env.',
	);
	compose(['up', '-d', ...(flags.has('--no-build') ? [] : ['--build'])]);
	const healthHost = bindAddress === '0.0.0.0' ? 'localhost' : bindAddress;
	const localOrigin = `http://${healthHost}:${port}`;
	await waitForHealth(localOrigin);
	const setupResponse = await fetch(`${localOrigin}/setup`, {
		redirect: 'manual',
		signal: AbortSignal.timeout(5000),
	});
	const setupPage =
		setupResponse.ok &&
		setupResponse.headers.get('x-flowdular-setup') === 'first-run';
	const url = `${publicOrigin}${setupPage ? '/setup' : appPath}`;
	console.log(`Flowdular is ready: ${url}`);
	if (setupPage) {
		console.log('Setup token from the application log:');
		const logs = compose(['logs', '--no-log-prefix', '--tail', '120', 'app'], {
			capture: true,
		});
		const token = /(?:^|\n)\s*Token\s+([^\s]+)/.exec(logs)?.[1];
		if (token) console.log(`  ${token}`);
		else
			console.log(
				'  Run: docker compose -f infra/docker/compose.yaml logs app',
			);
	}
	if (!flags.has('--no-open') && !openBrowser(url))
		console.log('Open the URL in a browser on this workstation.');
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
