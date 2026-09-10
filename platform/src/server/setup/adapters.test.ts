import { describe, expect, it } from 'vitest';
import {
	createSetupAdapters,
	PGLITE_ADAPTER_ID,
	POSTGRESQL_ADAPTER_ID,
} from './adapters.ts';

const PASSWORD = 'runtime-password-nobody-may-see';

function connection(overrides: Record<string, string> = {}) {
	return {
		config: {
			host: 'db.internal',
			port: '1',
			database: 'flowdular',
			'migrator-user': 'coreloom_migrator',
			'runtime-user': 'coreloom_runtime',
			'background-user': 'coreloom_background',
			tls: 'disable',
			...overrides,
		},
		secrets: {
			'migrator-password': 'migrator-password',
			'runtime-password': PASSWORD,
			'background-password': 'background-password',
		},
	};
}

describe('first-run adapters', () => {
	it('offers the embedded database only outside production', () => {
		const local = createSetupAdapters({
			workspaceRoot: '/workspace',
			production: false,
		});
		const deployed = createSetupAdapters({
			workspaceRoot: '/workspace',
			production: true,
		});

		expect(local.registry.list().map((entry) => entry.adapterId)).toEqual([
			PGLITE_ADAPTER_ID,
			POSTGRESQL_ADAPTER_ID,
		]);
		expect(deployed.registry.list().map((entry) => entry.adapterId)).toEqual([
			POSTGRESQL_ADAPTER_ID,
		]);
	});

	it('describes every field the form has to render', () => {
		const adapters = createSetupAdapters({
			workspaceRoot: '/workspace',
			production: false,
		});
		const postgresql = adapters.registry
			.list()
			.find((entry) => entry.adapterId === POSTGRESQL_ADAPTER_ID)!;

		const secrets = postgresql.configurationSchema.fields
			.filter((entry) => entry.secret)
			.map((entry) => entry.key);
		expect(secrets).toEqual([
			'migrator-password',
			'runtime-password',
			'background-password',
		]);
		const tls = postgresql.configurationSchema.fields.find(
			(entry) => entry.key === 'tls',
		)!;
		expect(tls.kind).toBe('select');
		expect(tls.options?.map((option) => option.value)).toEqual([
			'verify-full',
			'require',
			'disable',
		]);
		for (const field of postgresql.configurationSchema.fields) {
			expect(field.label.trim().length).toBeGreaterThan(0);
			expect(field.description.trim().length).toBeGreaterThan(0);
		}
	});

	it('names the exact field that is wrong without echoing what was typed', () => {
		const adapters = createSetupAdapters({
			workspaceRoot: '/workspace',
			production: false,
		});
		const postgresql = adapters.get(POSTGRESQL_ADAPTER_ID)!.descriptor;

		const issues = postgresql.validate({
			config: {
				host: '',
				port: '70000',
				database: 'bad name',
				'migrator-user': 'same',
				'runtime-user': 'same',
				'background-user': 'coreloom_background',
				tls: 'sometimes',
			},
			secrets: { 'runtime-password': PASSWORD },
		});

		expect(issues.map((issue) => issue.field)).toEqual([
			'host',
			'port',
			'database',
			'migrator-password',
			'background-password',
			'runtime-user',
			'tls',
		]);
		expect(JSON.stringify(issues)).not.toContain(PASSWORD);
	});

	it('accepts a complete configuration', () => {
		const adapters = createSetupAdapters({
			workspaceRoot: '/workspace',
			production: false,
		});

		expect(
			adapters.get(POSTGRESQL_ADAPTER_ID)!.descriptor.validate(connection()),
		).toEqual([]);
	});

	it('refuses anything but full verification in production', () => {
		const adapters = createSetupAdapters({
			workspaceRoot: '/workspace',
			production: true,
		});

		const issues = adapters
			.get(POSTGRESQL_ADAPTER_ID)!
			.descriptor.validate(connection({ tls: 'disable' }));

		expect(issues.map((issue) => issue.field)).toEqual(['tls']);
	});

	it('answers an unreachable server without a DSN, a host, or a password', async () => {
		const adapters = createSetupAdapters({
			workspaceRoot: '/workspace',
			production: false,
		});

		const result = await adapters
			.get(POSTGRESQL_ADAPTER_ID)!
			.descriptor.probe(connection({ host: '127.0.0.1', port: '1' }));

		expect(result.status).toBe('unavailable');
		expect(result.message).toBeTruthy();
		expect(result.message).not.toContain(PASSWORD);
		expect(result.message).not.toContain('postgresql://');
		expect(result.message).not.toContain('127.0.0.1');
		expect(result.message).not.toContain('coreloom_runtime');
	});

	it('builds the environment a restart needs, with every role separated', () => {
		const adapters = createSetupAdapters({
			workspaceRoot: '/workspace',
			production: false,
		});

		const environment = adapters
			.get(POSTGRESQL_ADAPTER_ID)!
			.environment(connection({ host: 'db.internal', port: '5432' }));

		expect(environment).toEqual({
			FD_DATABASE_ADAPTER: 'postgresql',
			FD_DATABASE_URL: `postgresql://coreloom_runtime:${encodeURIComponent(PASSWORD)}@db.internal:5432/flowdular`,
			FD_DATABASE_MIGRATOR_URL:
				'postgresql://coreloom_migrator:migrator-password@db.internal:5432/flowdular',
			FD_DATABASE_BACKGROUND_URL:
				'postgresql://coreloom_background:background-password@db.internal:5432/flowdular',
			FD_DATABASE_TLS: 'disable',
		});
	});

	it('points the embedded database at the workspace state directory', () => {
		const adapters = createSetupAdapters({
			workspaceRoot: '/workspace',
			production: false,
		});

		expect(
			adapters.get(PGLITE_ADAPTER_ID)!.environment({
				config: { 'data-directory': '' },
				secrets: {},
			}),
		).toEqual({
			FD_DATABASE_ADAPTER: 'pglite',
			FD_DATABASE_PGLITE_DIRECTORY: '/workspace/.flowdular/data/pglite',
		});
	});
});
