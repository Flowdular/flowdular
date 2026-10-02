import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDatabaseUrls } from './database-urls.mjs';

test('builds encoded URLs for old base64 passwords and drops raw copies', () => {
	const environment = {
		FD_DATABASE_RUNTIME_PASSWORD: 'a/b+c=@word',
		FD_DATABASE_MIGRATOR_PASSWORD: 'another/password',
		FD_DATABASE_BACKGROUND_PASSWORD: 'third/password',
	};
	installDatabaseUrls(environment);
	assert.equal(
		environment.FD_DATABASE_URL,
		'postgresql://coreloom_runtime:a%2Fb%2Bc%3D%40word@postgres:5432/flowdular',
	);
	assert.equal(
		new URL(environment.FD_DATABASE_MIGRATOR_URL).password,
		'another%2Fpassword',
	);
	assert.equal('FD_DATABASE_RUNTIME_PASSWORD' in environment, false);
});

test('preserves explicit connection strings', () => {
	const environment = {
		FD_DATABASE_URL: 'postgresql://external/database',
		FD_DATABASE_RUNTIME_PASSWORD: 'unused',
		FD_DATABASE_MIGRATOR_PASSWORD: 'migrator',
		FD_DATABASE_BACKGROUND_PASSWORD: 'background',
	};
	installDatabaseUrls(environment);
	assert.equal(environment.FD_DATABASE_URL, 'postgresql://external/database');
});
