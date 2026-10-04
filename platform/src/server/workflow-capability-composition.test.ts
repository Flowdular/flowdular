import { createContext } from '@octanejs/app-core';
import {
	createDataClassRegistry,
	createPlatformAgentRegistry,
	createPlatformCapabilityRegistry,
	createPlatformToolRegistry,
} from '@flowdular/kernel';
import type { PlatformServerContext } from '@flowdular/module-auth/server';
import { createServerComposition as composeAgents } from '@flowdular/module-agents/platform';
import { createServerComposition as composeWorkflows } from '@flowdular/module-workflows/platform';
import { afterAll, expect, it } from 'vitest';
import agentsManifest from '../../../modules/agents/module.json';
import workflowsManifest from '../../../modules/workflows/module.json';
import {
	closeAuthTestDatabases,
	signUpOwner,
	testRuntime,
} from '../../../modules/auth/tests/helpers.ts';

const origin = 'https://erp.example';

it('serves workflow detail and action catalog through manifest-scoped platform capabilities', async () => {
	const auth = await testRuntime();
	const owner = await signUpOwner(auth);
	const databases = auth.database.provider;
	const capabilities = createPlatformCapabilityRegistry();
	const dataClasses = createDataClassRegistry();
	const agentDefinitions = createPlatformAgentRegistry();
	const context = {
		environment: {
			NODE_ENV: 'test',
			FD_AGENT_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64'),
			FD_AGENT_RUN_GRANT_KEY: Buffer.alloc(32, 8).toString('base64'),
		},
		workspaceRoot: process.cwd(),
		auth,
		settings: auth.moduleSettings,
		databases,
		agentTools: createPlatformToolRegistry(),
		agentDefinitions,
		dataClasses,
		capabilities,
	};
	const agents = composeAgents({
		...context,
		agentDefinitions: agentDefinitions.forModule('agents.core'),
		dataClasses: dataClasses.forModule('agents.core'),
		capabilities: capabilities.forModule('agents.core', agentsManifest),
	} as unknown as PlatformServerContext);
	const workflows = composeWorkflows({
		...context,
		agentDefinitions: agentDefinitions.forModule('workflows.core'),
		dataClasses: dataClasses.forModule('workflows.core'),
		capabilities: capabilities.forModule('workflows.core', workflowsManifest),
	} as unknown as PlatformServerContext);
	const request = async (path: string, init: RequestInit = {}) => {
		const url = new URL(path, origin);
		const method = init.method ?? 'GET';
		const route = workflows.routes.find(
			(candidate) =>
				candidate.path === url.pathname && candidate.methods.includes(method),
		);
		if (!route) throw new Error(`Missing workflow route ${method} ${path}.`);
		const headers = new Headers(init.headers);
		headers.set('cookie', owner.cookie);
		const octane = createContext(new Request(url, { ...init, headers }), {});
		await auth.middleware(octane, async () => new Response(null));
		return route.handler(octane);
	};
	try {
		const created = await request('/api/workflows', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin,
				'x-csrf-token': owner.csrfToken,
			},
			body: JSON.stringify({
				key: 'capability-composition',
				name: 'Capability composition',
				description: '',
			}),
		});
		expect(created.status).toBe(201);
		const { definition } = (await created.json()) as {
			definition: { id: string };
		};
		const [detail, catalog] = await Promise.all([
			request(`/api/workflows/detail?id=${encodeURIComponent(definition.id)}`),
			request('/api/workflow-catalog/actions'),
		]);
		expect([
			{ status: detail.status, body: await detail.json() },
			{ status: catalog.status, body: await catalog.json() },
		]).toMatchObject([
			{ status: 200, body: { detail: { definition: { id: definition.id } } } },
			{ status: 200, body: { actions: expect.any(Array) } },
		]);
	} finally {
		await workflows.dispose?.();
		await agents.dispose?.();
		await auth.dispose();
	}
}, 60_000);

afterAll(closeAuthTestDatabases);
