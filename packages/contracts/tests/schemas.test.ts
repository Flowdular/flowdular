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
			'https://flowdular.dev/schemas/project.schema.json',
		);
		expect(moduleSchema.$id).toBe(
			'https://flowdular.dev/schemas/module.schema.json',
		);
		expect(moduleSpecSchema.$id).toBe(
			'https://flowdular.dev/schemas/module-spec.schema.json',
		);
		expect(blueprintSchema.$id).toBe(
			'https://flowdular.dev/schemas/blueprint.schema.json',
		);
		expect(cliExtensionSchema.$id).toBe(
			'https://flowdular.dev/schemas/cli-extension.schema.json',
		);
	});

	it('accepts both module specification versions and keeps version 1 closed', () => {
		expect(moduleSpecSchema.properties.schemaVersion.enum).toEqual([1, 2]);
		expect(moduleSpecSchema.additionalProperties).toBe(false);
		const version2Keys = [
			'entities',
			'screens',
			'actions',
			'widgets',
			'settings',
			'agentTools',
			'outOfScope',
			'decisions',
		];
		for (const key of version2Keys) {
			expect(Object.keys(moduleSpecSchema.properties)).toContain(key);
		}
		/* A version 1 document keeps its exact key set: the domain model is
		   rejected key by key instead of silently ignored. */
		const legacy = moduleSpecSchema.allOf[0]!;
		expect(legacy.if.properties.schemaVersion.const).toBe(1);
		expect(Object.keys(legacy.then.properties).sort()).toEqual(
			[...version2Keys].sort(),
		);
		expect(Object.values(legacy.then.properties)).toEqual(
			version2Keys.map(() => false),
		);
		expect(moduleSpecSchema.required).not.toContain('entities');
	});

	it('keeps enum and lifecycle values safe as stored values and SQL literals', () => {
		/* Both arrays reach a CHECK constraint of an immutable migration, so the
		   schema, not the generator, decides which characters can get there. */
		const values = moduleSpecSchema.$defs.enumValue;
		expect(values.pattern).toBe('^[a-z][a-z0-9_-]*$');
		expect(new RegExp(values.pattern).test("arch'ived")).toBe(false);
		expect(moduleSpecSchema.$defs.field.properties.values.items.$ref).toBe(
			'#/$defs/enumValue',
		);
		expect(
			moduleSpecSchema.$defs.entity.properties.states.properties.values.items
				.$ref,
		).toBe('#/$defs/enumValue');
	});

	it('lets flowdular.json configure the sandbox delivery without requiring it', () => {
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
			'official-modules',
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
