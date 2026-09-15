import { createContext } from '@octanejs/app-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	bindModuleCompositions,
	bindModuleRoutes,
	defineEndpoint,
	installModuleActivationGate,
	moduleOfRoute,
	type EndpointIdentity,
} from '../src/index.ts';

function endpoint(id: string, identity: EndpointIdentity | null) {
	return defineEndpoint({
		id,
		path: `/api/${id}`,
		methods: ['GET'],
		access: { kind: 'permission', permission: 'demo.read' },
		resolveIdentity: () => identity,
		handler: () => Response.json({ ok: true }),
	});
}

const owner: EndpointIdentity = {
	subjectId: 'owner',
	tenantId: 'tenant-a',
	permissions: new Set(['demo.read']),
};

const call = (route: { handler: (context: never) => unknown }) =>
	route.handler(
		createContext(new Request('http://localhost/api/demo'), {}) as never,
	) as Promise<Response>;

afterEach(() => installModuleActivationGate(null));

describe('module activation gate', () => {
	it('refuses an endpoint of a module the workspace deactivated with MODULE_INACTIVE', async () => {
		const isActive = vi.fn(
			async (tenantId: string, moduleId: string) =>
				!(tenantId === 'tenant-a' && moduleId === 'reports.core'),
		);
		installModuleActivationGate({ isActive });
		const reports = endpoint('reports.read', owner);
		bindModuleRoutes([reports.serverRoute], 'reports.core');

		const response = await call(reports.serverRoute);

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: 'MODULE_INACTIVE' },
		});
		expect(isActive).toHaveBeenCalledWith('tenant-a', 'reports.core');
	});

	it('serves an active module and never asks about a required one', async () => {
		const isActive = vi.fn(
			async (_tenantId: string, moduleId: string) =>
				moduleId === 'metering.core',
		);
		installModuleActivationGate({ isActive });
		const metering = endpoint('metering.read', owner);
		const users = endpoint('users.read', owner);
		bindModuleCompositions([
			{ moduleId: 'metering.core', routes: [metering.serverRoute] },
			{ moduleId: 'users.core', routes: [users.serverRoute] },
		]);

		expect((await call(metering.serverRoute)).status).toBe(200);
		expect((await call(users.serverRoute)).status).toBe(200);
		expect(isActive).toHaveBeenCalledTimes(1);
		expect(moduleOfRoute(users.serverRoute)).toBe('users.core');
	});

	it('skips the gate for an unbound route, an identity without a tenant and a missing gate', async () => {
		const isActive = vi.fn(async () => false);
		installModuleActivationGate({ isActive });
		const unbound = endpoint('demo.unbound', owner);
		const machine = endpoint('demo.machine', {
			subjectId: 'token',
			permissions: new Set(['demo.read']),
		});
		bindModuleRoutes([machine.serverRoute], 'demo.core');
		expect((await call(unbound.serverRoute)).status).toBe(200);
		expect((await call(machine.serverRoute)).status).toBe(200);
		expect(isActive).not.toHaveBeenCalled();
		expect(moduleOfRoute(unbound.serverRoute)).toBeNull();

		installModuleActivationGate(null);
		const gated = endpoint('demo.gated', owner);
		bindModuleRoutes([gated.serverRoute], 'demo.core');
		expect((await call(gated.serverRoute)).status).toBe(200);
	});

	it('checks the permission before the activation', async () => {
		const isActive = vi.fn(async () => false);
		installModuleActivationGate({ isActive });
		const denied = endpoint('demo.denied', {
			subjectId: 'member',
			tenantId: 'tenant-a',
			permissions: new Set(),
		});
		bindModuleRoutes([denied.serverRoute], 'demo.core');
		const response = await call(denied.serverRoute);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: 'FORBIDDEN' },
		});
		expect(isActive).not.toHaveBeenCalled();
	});
});
