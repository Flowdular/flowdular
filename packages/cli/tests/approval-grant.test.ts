import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createApprovalGrantKeyring,
	issueApprovalGrant,
	type ApprovalGrantKeyring,
} from '@flowdular/kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArguments } from '../src/arguments.ts';
import { invocationDigest, runCommand } from '../src/runner.ts';

let workspace: string;
const environment = { ...process.env };

const KEY_A = Buffer.alloc(32, 0x51);
const KEY_B = Buffer.alloc(32, 0x52);
const TENANT = 'tenant-a';

const CATALOG = {
	protocolVersion: 1,
	moduleId: 'probe.core',
	commands: [
		{
			path: ['probe', 'send'],
			capability: {
				id: 'probe.send',
				version: 1,
				summary: 'Send something outside the platform.',
				risk: 'external',
				requiresApprovedSpec: false,
				supportsDryRun: false,
			},
		},
		{
			path: ['probe', 'purge'],
			capability: {
				id: 'probe.purge',
				version: 1,
				summary: 'Remove records for good.',
				risk: 'destructive',
				requiresApprovedSpec: false,
				supportsDryRun: true,
				confirmation: 'purge-records',
			},
		},
	],
};

const ENTRY = `const capabilities = ${JSON.stringify(
	Object.fromEntries(
		CATALOG.commands.map((command) => [
			command.capability.id,
			command.capability,
		]),
	),
	null,
	'\t',
)};

export default Object.freeze({
	protocolVersion: 1,
	moduleId: 'probe.core',
	commands: [
		{
			path: ['probe', 'send'],
			capability: capabilities['probe.send'],
			execute: (context) => ({ data: { sent: context.arguments } }),
		},
		{
			path: ['probe', 'purge'],
			capability: capabilities['probe.purge'],
			execute: (context) => ({ data: { purged: context.apply } }),
		},
	],
});
`;

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'flowdular-approval-grant-'));
	const moduleRoot = join(workspace, 'modules/probe');
	await mkdir(join(moduleRoot, 'src/cli'), { recursive: true });
	await Promise.all([
		writeFile(
			join(workspace, 'flowdular.json'),
			'{"modules":{"enabled":["probe.core"]}}\n',
		),
		writeFile(
			join(moduleRoot, 'module.json'),
			`${JSON.stringify(
				{
					schemaVersion: 1,
					id: 'probe.core',
					package: '@flowdular/module-probe',
					version: '0.1.0',
					profile: 'full',
					capabilities: ['cli'],
					dependencies: [],
					tenancy: 'required',
					locales: ['en'],
					stability: 'experimental',
					cli: { catalog: 'src/cli/commands.json', entry: 'src/cli/index.ts' },
				},
				null,
				'\t',
			)}\n`,
		),
		writeFile(
			join(moduleRoot, 'src/cli/commands.json'),
			`${JSON.stringify(CATALOG, null, '\t')}\n`,
		),
		writeFile(join(moduleRoot, 'src/cli/index.ts'), ENTRY),
	]);
	process.env.NODE_ENV = 'development';
	process.env.FD_APPROVAL_GRANT_KEY = KEY_A.toString('base64');
	delete process.env.FD_APPROVAL_GRANT_KEY_PREVIOUS;
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) {
		if (!(key in environment)) delete process.env[key];
	}
	Object.assign(process.env, environment);
});

const SEND = ['probe', 'send', 'invoice-7', '--apply', '--tenant', TENANT];

function grant(
	keyring: ApprovalGrantKeyring,
	overrides: {
		readonly tenantId?: string;
		readonly capabilityId?: string;
		readonly path?: readonly string[];
		readonly expiresAt?: number;
	} = {},
): string {
	const parsed = parseArguments([
		'--root',
		workspace,
		...(overrides.path ?? SEND),
	]);
	const now = Date.now();
	return issueApprovalGrant(keyring, {
		tenantId: overrides.tenantId ?? TENANT,
		capabilityId: overrides.capabilityId ?? 'probe.send',
		inputDigest: invocationDigest(parsed, parsed.positionals.slice(2)),
		requestId: 'request-1',
		issuedAt: now - 1_000,
		expiresAt: overrides.expiresAt ?? now + 60_000,
		nonce: 'request-1',
	}).token;
}

async function run(path: readonly string[], token?: string) {
	return runCommand(
		parseArguments([
			'--root',
			workspace,
			...path,
			...(token === undefined ? [] : ['--grant', token]),
		]),
	);
}

describe('approval grants on the CLI runner', () => {
	it('refuses an external capability without a grant', async () => {
		const result = await run(SEND);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe('APPROVAL_VERIFIER_REQUIRED');
	});

	it('refuses a grant when no key is configured', async () => {
		const token = grant(createApprovalGrantKeyring({ current: KEY_A }));
		delete process.env.FD_APPROVAL_GRANT_KEY;
		const result = await run(SEND, token);
		expect(result.error?.code).toBe('APPROVAL_VERIFIER_REQUIRED');
	});

	it('refuses a grant signed under a foreign key', async () => {
		const token = grant(createApprovalGrantKeyring({ current: KEY_B }));
		const result = await run(SEND, token);
		expect(result.error?.code).toBe('APPROVAL_GRANT_INVALID');
	});

	it('refuses a grant for another tenant, capability or input', async () => {
		const ring = createApprovalGrantKeyring({ current: KEY_A });
		for (const token of [
			grant(ring, { tenantId: 'tenant-b' }),
			grant(ring, { capabilityId: 'probe.purge' }),
			grant(ring, {
				path: ['probe', 'send', 'invoice-8', '--apply', '--tenant', TENANT],
			}),
		]) {
			const result = await run(SEND, token);
			expect(result.error?.code).toBe('APPROVAL_GRANT_MISMATCH');
		}
		const withoutTenant = await run(
			['probe', 'send', 'invoice-7', '--apply'],
			grant(ring),
		);
		expect(withoutTenant.error?.code).toBe('APPROVAL_GRANT_MISMATCH');
	});

	it('refuses an expired grant', async () => {
		const token = grant(createApprovalGrantKeyring({ current: KEY_A }), {
			expiresAt: Date.now() - 1,
		});
		const result = await run(SEND, token);
		expect(result.error?.code).toBe('APPROVAL_GRANT_EXPIRED');
	});

	it('runs an external capability under a valid grant', async () => {
		const token = grant(createApprovalGrantKeyring({ current: KEY_A }));
		const result = await run(SEND, token);
		expect(result.ok).toBe(true);
		expect(result.data).toEqual({ sent: ['invoice-7'] });
	});

	/* The runner records no use: it has no platform connection to write one on,
	   so the window from the approval is the only bound on a repeat. */
	it('accepts the same grant again until its expiry', async () => {
		const token = grant(createApprovalGrantKeyring({ current: KEY_A }));
		expect((await run(SEND, token)).ok).toBe(true);
		expect((await run(SEND, token)).ok).toBe(true);
	});

	it('runs under a grant issued before the key was rotated', async () => {
		const token = grant(createApprovalGrantKeyring({ current: KEY_A }));
		process.env.FD_APPROVAL_GRANT_KEY = KEY_B.toString('base64');
		process.env.FD_APPROVAL_GRANT_KEY_PREVIOUS = KEY_A.toString('base64');
		const result = await run(SEND, token);
		expect(result.ok).toBe(true);
	});

	it('keeps the confirmation of a destructive capability under a grant', async () => {
		const ring = createApprovalGrantKeyring({ current: KEY_A });
		const path = ['probe', 'purge', '--apply', '--tenant', TENANT];
		const token = grant(ring, { capabilityId: 'probe.purge', path });
		const unconfirmed = await run(path, token);
		expect(unconfirmed.error?.code).toBe('CONFIRMATION_REQUIRED');
		const confirmed = await run([...path, '--confirm', 'purge-records'], token);
		expect(confirmed.ok).toBe(true);
		expect(confirmed.data).toEqual({ purged: true });
		expect((await run(path)).error?.code).toBe('APPROVAL_VERIFIER_REQUIRED');
	});
});
