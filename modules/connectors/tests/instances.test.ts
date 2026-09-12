import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_JSON_DEFINITION } from '../src/domain/http-json.ts';
import type { CreateConnectorInstanceInput } from '../src/domain/types.ts';
import { ConnectorsServiceError } from '../src/services/service-error.ts';
import {
	openConnectorsTestDatabase,
	type ConnectorsTestDatabase,
} from './support/database.ts';
import { instanceService, testVault } from './support/harness.ts';

const TENANT = 'tenant-crud';
const ACTOR = 'account-ada';

const INPUT: CreateConnectorInstanceInput = {
	definitionKey: HTTP_JSON_DEFINITION.key,
	name: 'Billing API',
	baseUrl: 'https://api.example.test/v1',
	authKind: 'api-key',
	credentials: { header: 'x-api-key', value: 'secret-value-0001' },
	allowedHosts: ['api.example.test'],
};

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

function service() {
	return instanceService(shared.repository, testVault());
}

describe('CONNECTORS-INSTANCE-CRUD', () => {
	it('creates an active instance whose credential is sealed and never returned', async () => {
		const created = await service().create(TENANT, ACTOR, INPUT);
		expect(created).toMatchObject({
			tenantId: TENANT,
			name: 'Billing API',
			authKind: 'api-key',
			status: 'active',
			allowWorkflows: false,
			allowAgents: false,
			allowedHosts: ['api.example.test'],
		});
		expect(created.credentialFingerprint).toHaveLength(32);
		expect(JSON.stringify(created)).not.toContain('secret-value-0001');

		const listed = await service().list(TENANT);
		expect(JSON.stringify(listed)).not.toContain('secret-value-0001');
		expect(Object.keys(listed[0] ?? {})).not.toContain('credential');
	});

	it('refuses a second instance with the same name in the workspace', async () => {
		await service().create(TENANT, ACTOR, INPUT);
		await expect(service().create(TENANT, ACTOR, INPUT)).rejects.toMatchObject({
			code: 'INSTANCE_NAME_TAKEN',
			status: 409,
		});
	});

	it('changes only the fingerprint when the credential is replaced', async () => {
		const created = await service().create(TENANT, ACTOR, INPUT);
		const unchanged = await service().update(TENANT, ACTOR, created.id, {
			name: 'Billing API v2',
			baseUrl: created.baseUrl,
			allowedHosts: created.allowedHosts,
		});
		expect(unchanged.credentialFingerprint).toBe(created.credentialFingerprint);
		expect(unchanged.name).toBe('Billing API v2');

		const replaced = await service().update(TENANT, ACTOR, created.id, {
			name: 'Billing API v2',
			baseUrl: created.baseUrl,
			allowedHosts: created.allowedHosts,
			credentials: { header: 'x-api-key', value: 'another-secret-0002' },
		});
		expect(replaced.credentialFingerprint).not.toBe(
			created.credentialFingerprint,
		);
		expect(JSON.stringify(replaced)).not.toContain('another-secret-0002');
	});

	it('refuses deleting an active instance and accepts it once disabled', async () => {
		const created = await service().create(TENANT, ACTOR, INPUT);
		await expect(
			service().remove(TENANT, ACTOR, created.id),
		).rejects.toMatchObject({ code: 'INSTANCE_ACTIVE', status: 409 });

		const disabled = await service().disable(TENANT, ACTOR, created.id);
		expect(disabled.status).toBe('disabled');
		const enabled = await service().enable(TENANT, ACTOR, created.id);
		expect(enabled.status).toBe('active');

		await service().disable(TENANT, ACTOR, created.id);
		await service().remove(TENANT, ACTOR, created.id);
		expect(await service().list(TENANT)).toEqual([]);
	});

	it('records one audit row per accepted transition', async () => {
		const created = await service().create(TENANT, ACTOR, INPUT);
		await service().update(TENANT, ACTOR, created.id, {
			name: 'Billing API',
			baseUrl: created.baseUrl,
			allowedHosts: created.allowedHosts,
		});
		await service().consent(TENANT, ACTOR, created.id, {
			allowWorkflows: true,
			allowAgents: false,
			confirmed: true,
		});
		await service().disable(TENANT, ACTOR, created.id);

		const audit = await service().listAudit(TENANT, created.id);
		expect(audit.map((entry) => entry.action)).toEqual([
			'instance.disabled',
			'instance.consent-changed',
			'instance.updated',
			'instance.created',
		]);
		expect(audit.every((entry) => entry.actorId === ACTOR)).toBe(true);
		expect(
			audit.find((entry) => entry.action === 'instance.consent-changed')
				?.metadata,
		).toEqual({ allowWorkflows: true, allowAgents: false });
	});

	it('refuses an unknown definition and an unsupported authentication kind', async () => {
		await expect(
			service().create(TENANT, ACTOR, { ...INPUT, definitionKey: 'absent' }),
		).rejects.toMatchObject({ code: 'DEFINITION_UNKNOWN' });
		await expect(
			service().create(TENANT, ACTOR, {
				...INPUT,
				authKind: 'api-key',
				credentials: { value: 'only-the-value' },
			}),
		).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
	});

	it('defaults the allowlist to the base URL host and refuses one without it', async () => {
		const created = await service().create(TENANT, ACTOR, {
			...INPUT,
			allowedHosts: [],
		});
		expect(created.allowedHosts).toEqual(['api.example.test']);
		await expect(
			service().create(TENANT, ACTOR, {
				...INPUT,
				name: 'Other',
				allowedHosts: ['elsewhere.example.test'],
			}),
		).rejects.toMatchObject({ code: 'HOST_NOT_ALLOWLISTED' });
	});

	/* A control character in a credential becomes a header or form-body
	   injection once the call path writes it to the socket. */
	it('refuses a credential carrying a control character', async () => {
		for (const value of [
			'secret\u0000value',
			'secret\r\nx-injected: 1',
			'secret\u007f',
		]) {
			await expect(
				service().create(TENANT, ACTOR, {
					...INPUT,
					name: `Control ${value.length}`,
					credentials: { header: 'x-api-key', value },
				}),
			).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
		}
		await expect(
			service().create(TENANT, ACTOR, {
				...INPUT,
				credentials: { header: 'x-api\u0000key', value: 'secret-value-0001' },
			}),
		).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
		expect(await service().list(TENANT)).toEqual([]);
	});

	/* The generic definition names 443 and nothing else, so an instance cannot
	   be aimed at a service answering on another port of a public host. */
	it('refuses a base URL on a port the definition does not name', async () => {
		await expect(
			service().create(TENANT, ACTOR, {
				...INPUT,
				baseUrl: 'https://api.example.test:8443/v1',
			}),
		).rejects.toMatchObject({ code: 'PORT_NOT_ALLOWED' });
		const created = await service().create(TENANT, ACTOR, {
			...INPUT,
			baseUrl: 'https://api.example.test:443/v1',
		});
		expect(created.baseUrl).toBe('https://api.example.test/v1');
	});

	it('refuses an OAuth2 token URL on a port the definition does not name', async () => {
		await expect(
			service().create(TENANT, ACTOR, {
				...INPUT,
				authKind: 'oauth2-client-credentials',
				credentials: {
					tokenUrl: 'https://api.example.test:8443/token',
					clientId: 'client-0001',
					clientSecret: 'client-secret-0001',
				},
			}),
		).rejects.toMatchObject({ code: 'PORT_NOT_ALLOWED' });
	});

	it('reports a missing instance as a not found error', async () => {
		await expect(
			service().disable(TENANT, ACTOR, 'absent-instance'),
		).rejects.toBeInstanceOf(ConnectorsServiceError);
		await expect(
			service().disable(TENANT, ACTOR, 'absent-instance'),
		).rejects.toMatchObject({ code: 'INSTANCE_NOT_FOUND', status: 404 });
	});
});
