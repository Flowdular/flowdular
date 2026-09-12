import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	call,
	closeAuthTestDatabases,
	ORIGIN,
	signUpOwner,
	testRuntime,
	type TestRuntime,
} from './helpers.ts';
import { authTestProvider } from './support/database.ts';

/* The workspace lookup limiter is module state in server/endpoints.ts, so this
   case runs in a file of its own: spending a whole window here must not reach
   the other suites. */

const open = new Set<TestRuntime>();

beforeAll(async () => {
	await authTestProvider();
}, 60_000);

afterEach(async () => {
	await Promise.all([...open].map((runtime) => runtime.dispose()));
	open.clear();
});

afterAll(closeAuthTestDatabases);

async function configuration(
	runtime: TestRuntime,
	workspace: string,
	agent: string,
): Promise<Response> {
	return call(
		runtime,
		'/api/auth/config',
		new Request(
			`${ORIGIN}/api/auth/config?workspace=${encodeURIComponent(workspace)}`,
			{ headers: { 'user-agent': agent } },
		),
	);
}

describe('AUTH-SIGNIN-WORKSPACE-ROUTING workspace lookup limit', () => {
	it('bounds one workspace reference and leaves another workspace reachable, with no client address', async () => {
		/* FD_TRUST_PROXY is false by default, so clientAddress() answers null and
		   the only thing left to key on is the workspace being asked for. */
		const runtime = await testRuntime({ trustProxy: false });
		open.add(runtime);
		await signUpOwner(runtime, 'first@example.com', 'alpha-operations');
		await signUpOwner(runtime, 'second@example.com', 'beta-operations');

		const statuses: number[] = [];
		for (let attempt = 0; attempt < 121; attempt += 1) {
			statuses.push(
				(await configuration(runtime, 'alpha-operations', `agent-${attempt}`))
					.status,
			);
		}

		/* The bound belongs to the workspace, not to the caller's user-agent: 120
		   lookups of one reference are served and the 121st is refused, however
		   many different agents sent them. */
		expect(statuses.slice(0, 120)).toEqual(
			Array.from({ length: 120 }, () => 200),
		);
		expect(statuses[120]).toBe(429);

		const other = await configuration(runtime, 'beta-operations', 'agent-121');
		expect(other.status).toBe(200);
		expect(
			(
				(await other.json()) as {
					workspace: { slug: string } | null;
				}
			).workspace?.slug,
		).toBe('beta-operations');
	}, 60_000);
});
