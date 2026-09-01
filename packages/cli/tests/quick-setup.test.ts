import { describe, expect, it } from 'vitest';
import { parseArguments } from '../src/arguments.ts';
import { runCommand } from '../src/runner.ts';

describe('quick setup', () => {
	it('previews both accounts and tenants without applying the reset', async () => {
		const result = await runCommand(parseArguments(['setup', 'quick']));
		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({
			applied: false,
			accounts: {
				admin: { email: 'admin@example.com' },
				user: { email: 'user@example.com' },
			},
			tenants: ['Operations Demo', 'Finance Demo'],
		});
		expect(result.warnings.join(' ')).toContain('No data was changed');
	});
});
