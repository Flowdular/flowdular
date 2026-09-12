import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { moduleDefinition } from '../src/index.ts';
import manifest from '../module.json' with { type: 'json' };
import { CONNECTORS_PERMISSIONS } from '../src/acl/permissions.ts';
import { HTTP_JSON_DEFINITION } from '../src/domain/http-json.ts';
import {
	openConnectorsTestDatabase,
	type ConnectorsTestDatabase,
} from './support/database.ts';
import { instanceService, testVault } from './support/harness.ts';

let shared: ConnectorsTestDatabase;

beforeAll(async () => {
	shared = await openConnectorsTestDatabase();
});

afterAll(async () => {
	await shared?.dispose();
});

afterEach(async () => {
	await shared.reset();
});

describe('connectors.core module', () => {
	it('declares its identity, permissions and public capabilities', () => {
		expect(moduleDefinition.manifest.id).toBe('connectors.core');
		expect(moduleDefinition.permissions).toEqual([
			CONNECTORS_PERMISSIONS.read,
			CONNECTORS_PERMISSIONS.manage,
		]);
		expect(manifest.provides).toEqual([
			'connectors.definitions.v1',
			'connectors.calls.v1',
		]);
	});

	it('ships the generic HTTP JSON definition with one operation per method', () => {
		const service = instanceService(shared.repository, testVault());
		const definition = service
			.definitions()
			.find((entry) => entry.key === HTTP_JSON_DEFINITION.key);
		expect(definition?.moduleId).toBe('connectors.core');
		expect(definition?.operations.map((operation) => operation.key)).toEqual([
			'get',
			'post',
			'put',
			'patch',
			'delete',
		]);
		expect(definition?.authKinds).toEqual([
			'none',
			'api-key',
			'bearer',
			'oauth2-client-credentials',
		]);
	});

	/* CONNECTORS-TENANT-BOUNDARY: the same name in two workspaces is two rows,
	   and neither workspace can read the other's. */
	it('keeps instances of two workspaces apart', async () => {
		const service = instanceService(shared.repository, testVault());
		const input = {
			definitionKey: HTTP_JSON_DEFINITION.key,
			name: 'Billing',
			baseUrl: 'https://api.example.test/v1',
			authKind: 'none' as const,
			credentials: {},
			allowedHosts: ['api.example.test'],
		};
		await service.create('tenant-a', 'account-ada', input);
		await service.create('tenant-b', 'account-bob', input);

		expect((await service.list('tenant-a')).map((row) => row.tenantId)).toEqual(
			['tenant-a'],
		);
		expect((await service.list('tenant-b')).map((row) => row.tenantId)).toEqual(
			['tenant-b'],
		);
	});
});
