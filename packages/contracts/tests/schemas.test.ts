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
		expect(projectSchema.$id).toContain('project.schema.json');
		expect(moduleSchema.$id).toContain('module.schema.json');
		expect(moduleSpecSchema.$id).toContain('module-spec.schema.json');
		expect(blueprintSchema.$id).toContain('blueprint.schema.json');
		expect(cliExtensionSchema.$id).toContain('cli-extension.schema.json');
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
			'provider',
			'remote',
			'reviewers',
		]);
	});
});
