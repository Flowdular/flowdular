import { describe, expect, it } from 'vitest';
import {
	blueprintSchema,
	cliExtensionSchema,
	moduleSchema,
	moduleSpecSchema,
	projectSchema,
} from '../src/schemas.ts';

describe('contract schemas', () => {
	it('exports schemas with stable ids', () => {
		expect(projectSchema.$id).toBe(
			'https://coreloom.dev/schemas/project.schema.json',
		);
		expect(moduleSchema.$id).toBe(
			'https://coreloom.dev/schemas/module.schema.json',
		);
		expect(moduleSpecSchema.$id).toBe(
			'https://coreloom.dev/schemas/module-spec.schema.json',
		);
		expect(blueprintSchema.$id).toBe(
			'https://coreloom.dev/schemas/blueprint.schema.json',
		);
		expect(cliExtensionSchema.$id).toBe(
			'https://coreloom.dev/schemas/cli-extension.schema.json',
		);
	});

	it('lets coreloom.json configure the sandbox delivery without requiring it', () => {
		expect(projectSchema.required).not.toContain('sandbox');
		const delivery = projectSchema.properties.sandbox.properties.delivery;
		expect(Object.keys(delivery.properties).sort()).toEqual([
			'default',
			'git',
			'maxChangedFiles',
			'targets',
		]);
		expect(projectSchema.$defs.deliveryTarget.enum).toEqual([
			'workspace',
			'git-pr',
		]);
		expect(Object.keys(delivery.properties.git.properties).sort()).toEqual([
			'baseBranch',
			'branchPrefix',
			'forkOwner',
			'mode',
			'provider',
			'remote',
			'repository',
			'reviewers',
		]);
	});
});
