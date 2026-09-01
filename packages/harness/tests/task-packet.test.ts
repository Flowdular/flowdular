import { describe, expect, it } from 'vitest';
import { validateTaskPacket, type TaskPacket } from '../src/index.ts';

const valid: TaskPacket = {
	schemaVersion: 1,
	taskId: 'task-sales-orders',
	capability: 'module.create',
	blueprint: 'new-module@1.0.0',
	spec: 'modules/sales-orders/spec/module.yaml',
	specStatus: 'approved',
	allowedPaths: ['modules/sales-orders/**'],
	steps: ['dry-run', 'apply', 'verify'],
	gates: ['typecheck', 'test'],
};

describe('task packet guardrails', () => {
	it('accepts an explicit, module-bounded packet', () => {
		expect(validateTaskPacket(valid)).toEqual([]);
	});

	it.each(['platform/**', 'modules/**', 'packages/**', 'infra/**', '.ai/**'])(
		'rejects the broad path %s',
		(path) => {
			expect(
				validateTaskPacket({ ...valid, allowedPaths: [path] }),
			).toContainEqual(
				expect.objectContaining({ code: 'PATH_SCOPE_TOO_BROAD' }),
			);
		},
	);
});
