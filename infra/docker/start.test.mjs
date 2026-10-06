import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { ensureEnvironmentFile } from './start.mjs';

function fixture(fn) {
	const directory = mkdtempSync(join(tmpdir(), 'flowdular-docker-start-'));
	try {
		const path = join(directory, '.env');
		const template = join(directory, '.env.example');
		writeFileSync(
			template,
			'FD_PORT=3000\nFD_AUTH_SECURE_COOKIE=\nFD_STORAGE_S3_FORCE_PATH_STYLE=\n',
		);
		return fn({ path, template });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test('first launch persists distinct credentials and a local HTTP cookie once', () =>
	fixture(({ path, template }) => {
		const first = ensureEnvironmentFile(path, template, {});
		const contents = readFileSync(path, 'utf8');
		const values = parseEnv(contents);
		assert.equal(first.port, 3000);
		assert.match(first.projectName, /^flowdular-[a-f0-9]{12}$/);
		assert.equal(values.COMPOSE_PROJECT_NAME, first.projectName);
		assert.equal(values.FD_AUTH_SECURE_COOKIE, 'false');
		assert.equal(values.FD_STORAGE_S3_ENDPOINT, 'http://minio:9000');
		assert.match(values.FD_DATABASE_RUNTIME_PASSWORD, /^[a-f0-9]{64}$/);
		assert.match(values.FD_MINIO_ROOT_PASSWORD, /^[a-f0-9]{64}$/);
		assert.equal(
			Buffer.from(values.FD_AGENT_CREDENTIAL_KEY, 'base64').length,
			32,
		);
		assert.notEqual(
			values.FD_DATABASE_RUNTIME_PASSWORD,
			values.FD_DATABASE_MIGRATOR_PASSWORD,
		);
		if (process.platform !== 'win32')
			assert.equal(statSync(path).mode & 0o777, 0o600);
		const second = ensureEnvironmentFile(path, template, {});
		assert.equal(second.generated, 0);
		assert.equal(second.projectName, first.projectName);
		assert.equal(readFileSync(path, 'utf8'), contents);
	}));

test('existing secrets and explicit settings survive bootstrap', () =>
	fixture(({ path, template }) => {
		writeFileSync(
			path,
			'FD_DATABASE_RUNTIME_PASSWORD=base64/with+symbols=\nFD_AUTH_SECURE_COOKIE=true\nFD_AUTH_PUBLIC_ORIGIN=https://flowdular.example.test\nFD_PORT=4100\n',
		);
		const result = ensureEnvironmentFile(path, template, {});
		const values = parseEnv(readFileSync(path, 'utf8'));
		assert.equal(result.port, 4100);
		assert.equal(result.projectName, 'docker');
		assert.equal(values.FD_DATABASE_RUNTIME_PASSWORD, 'base64/with+symbols=');
		assert.equal(values.FD_AUTH_SECURE_COOKIE, 'true');
		assert.equal(result.publicOrigin, 'https://flowdular.example.test');
	}));

test('new apps receive different persisted Compose project names', () => {
	let firstProject;
	fixture(({ path, template }) => {
		firstProject = ensureEnvironmentFile(path, template, {}).projectName;
	});
	fixture(({ path, template }) => {
		const secondProject = ensureEnvironmentFile(path, template, {}).projectName;
		assert.notEqual(secondProject, firstProject);
	});
});

test('an existing Compose project name cannot be changed by the shell', () =>
	fixture(({ path, template }) => {
		writeFileSync(path, 'COMPOSE_PROJECT_NAME=existing-app\n');
		assert.throws(
			() =>
				ensureEnvironmentFile(path, template, {
					COMPOSE_PROJECT_NAME: 'other-app',
				}),
			/COMPOSE_PROJECT_NAME differs/,
		);
		assert.equal(
			readFileSync(path, 'utf8'),
			'COMPOSE_PROJECT_NAME=existing-app\n',
		);
	}));

test('old secure-cookie setting gives a clear error on local HTTP', () =>
	fixture(({ path, template }) => {
		writeFileSync(path, 'FD_AUTH_SECURE_COOKIE=true\nFD_PORT=3000\n');
		assert.throws(
			() => ensureEnvironmentFile(path, template, {}),
			/Set it to false in infra\/docker\/\.env or use an HTTPS origin/,
		);
		assert.equal(
			readFileSync(path, 'utf8'),
			'FD_AUTH_SECURE_COOKIE=true\nFD_PORT=3000\n',
		);
	}));

test('conflicting shell secret cannot silently replace a persisted password', () =>
	fixture(({ path, template }) => {
		writeFileSync(path, 'FD_DATABASE_RUNTIME_PASSWORD=original\n');
		assert.throws(
			() =>
				ensureEnvironmentFile(path, template, {
					FD_DATABASE_RUNTIME_PASSWORD: 'replacement',
				}),
			/FD_DATABASE_RUNTIME_PASSWORD differs/,
		);
		assert.equal(
			readFileSync(path, 'utf8'),
			'FD_DATABASE_RUNTIME_PASSWORD=original\n',
		);
	}));

test('external S3 credentials are required before starting', () =>
	fixture(({ path, template }) => {
		assert.throws(
			() =>
				ensureEnvironmentFile(path, template, {
					FD_STORAGE_S3_ENDPOINT: 'https://s3.example.test',
				}),
			/FD_STORAGE_S3_ACCESS_KEY_ID and FD_STORAGE_S3_SECRET_ACCESS_KEY/,
		);
		assert.equal(readFileSync(template, 'utf8').includes('FD_PORT=3000'), true);
	}));

test('an existing AWS S3 configuration keeps its empty endpoint and virtual-host addressing', () =>
	fixture(({ path, template }) => {
		writeFileSync(
			path,
			'FD_STORAGE_S3_ENDPOINT=\nFD_STORAGE_S3_ACCESS_KEY_ID=existing-access\nFD_STORAGE_S3_SECRET_ACCESS_KEY=existing-secret\nFD_STORAGE_S3_BUCKET=existing-bucket\nFD_STORAGE_S3_FORCE_PATH_STYLE=false\n',
		);
		ensureEnvironmentFile(path, template, {});
		const values = parseEnv(readFileSync(path, 'utf8'));
		assert.equal(values.FD_STORAGE_S3_ENDPOINT, '');
		assert.equal(values.FD_STORAGE_S3_FORCE_PATH_STYLE, 'false');
		assert.equal(values.FD_STORAGE_S3_ACCESS_KEY_ID, 'existing-access');
	}));

test('rejects app paths that the platform cannot route', () =>
	fixture(({ path, template }) => {
		for (const appPath of ['/', '/finance/expenses', '/API', '/setup']) {
			assert.throws(
				() =>
					ensureEnvironmentFile(path, template, {
						FD_APPLICATION_PATH: appPath,
					}),
				/FD_APPLICATION_PATH must be one available path/,
			);
		}
		assert.equal(statSync(path, { throwIfNoEntry: false }), undefined);
	}));

test('checks health on the configured bind address', () =>
	fixture(({ path, template }) => {
		const result = ensureEnvironmentFile(path, template, {
			FD_BIND_ADDRESS: '192.168.1.5',
		});
		assert.equal(result.bindAddress, '192.168.1.5');
	}));

test('refuses a concurrent environment update before changing credentials', () =>
	fixture(({ path, template }) => {
		writeFileSync(`${path}.lock`, 'in progress');
		assert.throws(
			() => ensureEnvironmentFile(path, template, {}),
			/Another launcher is preparing/,
		);
		assert.equal(statSync(path, { throwIfNoEntry: false }), undefined);
	}));

test('preloader sets database URLs and then runs the requested main script', () =>
	fixture(({ path }) => {
		const script = join(dirname(path), 'main.mjs');
		writeFileSync(
			script,
			"import assert from 'node:assert/strict';\n" +
				"assert.equal(process.env.FD_DATABASE_URL, 'postgresql://flowdular_runtime:a%2Fb@postgres:5432/flowdular');\n" +
				'assert.equal(process.env.FD_DATABASE_RUNTIME_PASSWORD, undefined);\n' +
				"assert.ok(process.argv[1].endsWith('main.mjs'));\n",
		);
		const preloader = fileURLToPath(
			new URL('./app-entrypoint.mjs', import.meta.url),
		);
		const result = spawnSync(
			process.execPath,
			['--import', preloader, script],
			{
				encoding: 'utf8',
				env: {
					...process.env,
					FD_DATABASE_ADAPTER: 'postgresql',
					FD_DATABASE_RUNTIME_PASSWORD: 'a/b',
					FD_DATABASE_MIGRATOR_PASSWORD: 'migrator',
					FD_DATABASE_BACKGROUND_PASSWORD: 'background',
					FD_DATABASE_URL: '',
					FD_DATABASE_MIGRATOR_URL: '',
					FD_DATABASE_BACKGROUND_URL: '',
				},
			},
		);
		assert.equal(result.status, 0, result.stderr);
	}));

test('the shipped template uses an HTTP cookie and a requested local port', () =>
	fixture(({ path }) => {
		const template = new URL('.env.example', import.meta.url);
		const result = ensureEnvironmentFile(path, template, { FD_PORT: '4100' });
		const values = parseEnv(readFileSync(path, 'utf8'));
		assert.equal(result.port, 4100);
		assert.equal(result.appPath, '/app');
		assert.equal(values.FD_AUTH_SECURE_COOKIE, 'false');
	}));

test('every value the shipped template documents reaches compose', () => {
	const example = parseEnv(
		readFileSync(new URL('.env.example', import.meta.url), 'utf8'),
	);
	const compose = readFileSync(
		new URL('compose.yaml', import.meta.url),
		'utf8',
	);
	/* The app service lists its environment explicitly, so a key the operator
	   sets in .env that compose never names is dropped without a warning.
	   Compose reads the project name itself. */
	assert.ok('FD_OPERATOR_TENANT' in example);
	for (const key of Object.keys(example)) {
		if (key === 'COMPOSE_PROJECT_NAME') continue;
		assert.match(compose, new RegExp(`\\$\\{${key}[:?}-]`), key);
	}
});
