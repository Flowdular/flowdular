import {
	AUTH_PRINCIPAL_STATE_KEY,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AGENT_PERMISSIONS } from '../src/acl/permissions.ts';
import { createAgentRoutes } from '../src/api/endpoints.ts';
import type { AgentRuntime } from '../src/server/runtime.ts';

const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
	unhandled.length = 0;
	process.on('unhandledRejection', recordUnhandled);
});

afterEach(() => {
	process.off('unhandledRejection', recordUnhandled);
});

/* The run read waits for the test, so the observer can leave while one is in
   flight: a client closing the tab, or the platform runtime retiring. */
function openStream() {
	let settleRead!: (read: () => unknown) => void;
	const getRun = vi.fn(
		() =>
			new Promise((resolve) => {
				settleRead = (read) => resolve(Promise.resolve().then(read));
			}),
	);
	const runtime = {
		service: async () => ({ getRun }),
	} as unknown as AgentRuntime;
	const stream = createAgentRoutes({} as AuthRuntime, runtime).find(
		(route) => route.path === '/api/agent-runs/stream',
	)!;
	const request = new Request(
		'https://erp.example/api/agent-runs/stream?id=run-1&after=0',
	);
	const state = new Map<string, unknown>([
		[
			AUTH_PRINCIPAL_STATE_KEY,
			{
				accountId: 'account-a',
				tenantId: 'tenant-a',
				email: 'owner@example.test',
				displayName: 'Owner',
				role: 'owner',
				scopes: [AGENT_PERMISSIONS.runsRead],
				tenants: [],
			},
		],
	]);
	const response = stream.handler({
		request,
		params: {},
		url: new URL(request.url),
		state,
	} as never);
	return {
		response,
		getRun,
		settle: (read: () => unknown) => settleRead(read),
	};
}

it.each([
	[
		'answers with a new event',
		() => ({
			id: 'run-1',
			status: 'running',
			procedureSnapshots: [],
			events: [{ sequence: 1, type: 'run.started' }],
		}),
	],
	[
		'fails because the runtime closed its database',
		() => {
			throw new Error('The database provider was disposed.');
		},
	],
])(
	'stops quietly when the observer leaves while a run read %s',
	async (_case, read) => {
		const { response, getRun, settle } = openStream();
		const reader = (await response).body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			'retry: 1000\n\n',
		);
		await vi.waitFor(() => expect(getRun).toHaveBeenCalledOnce());

		await reader.cancel();
		settle(read);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(unhandled).toEqual([]);
	},
);
