import { describe, expect, it } from 'vitest';
import { MeterDeclarationRegistry } from '../src/services/meter-registry.ts';
import { MeteringServiceError } from '../src/services/service-error.ts';
import { RUN_TOKENS } from './support/harness.ts';

function registry(): MeterDeclarationRegistry {
	return new MeterDeclarationRegistry();
}

describe('METERING-DECLARE-RECORD declaration rules', () => {
	it('composes the full key from the module id and the declared key', () => {
		const meters = registry();
		meters.declare('agents.core', [RUN_TOKENS]);

		expect(meters.resolve('agents.core.run-tokens')).toEqual({
			moduleId: 'agents.core',
			key: 'agents.core.run-tokens',
			label: RUN_TOKENS.label,
			unit: RUN_TOKENS.unit,
			kind: RUN_TOKENS.kind,
		});
		expect(meters.resolve('run-tokens')).toBeNull();
		expect(meters.list()).toHaveLength(1);
	});

	it('refuses a declaration once the platform sealed the registry', () => {
		const meters = registry();
		meters.seal();

		expect(() => meters.declare('agents.core', [RUN_TOKENS])).toThrow(
			MeteringServiceError,
		);
		expect(meters.sealed).toBe(true);
	});

	it('refuses a second declaration by the same module', () => {
		const meters = registry();
		meters.declare('agents.core', [RUN_TOKENS]);

		expect(() => meters.declare('agents.core', [])).toThrow(
			/declared its meters twice/,
		);
	});

	it('refuses the same key twice in one declaration and keeps the registry whole', () => {
		const meters = registry();

		expect(() =>
			meters.declare('agents.core', [RUN_TOKENS, { ...RUN_TOKENS }]),
		).toThrow(/twice/);
		expect(meters.list()).toHaveLength(0);
	});

	it('gives two modules declaring the same local key one meter each', () => {
		const meters = registry();
		meters.declare('agents.core', [RUN_TOKENS]);
		meters.declare('workflows.core', [RUN_TOKENS]);

		expect(meters.list().map((meter) => meter.key)).toEqual([
			'agents.core.run-tokens',
			'workflows.core.run-tokens',
		]);
	});

	/* A module declaring several meters is all or nothing: one refused entry
	   must not leave the earlier ones of the same call behind. */
	it('records nothing when one meter of a module is invalid', () => {
		const meters = registry();

		expect(() =>
			meters.declare('agents.core', [
				RUN_TOKENS,
				{ ...RUN_TOKENS, key: 'Run Tokens' },
			]),
		).toThrow(MeteringServiceError);
		expect(meters.list()).toHaveLength(0);
	});

	it('refuses a module id, a label, a unit and a kind it cannot use', () => {
		expect(() => registry().declare('agents', [RUN_TOKENS])).toThrow(
			/is not a module id/,
		);
		expect(() =>
			registry().declare('agents.core', [{ ...RUN_TOKENS, label: '' }]),
		).toThrow(/needs a label/);
		expect(() =>
			registry().declare('agents.core', [{ ...RUN_TOKENS, unit: '' }]),
		).toThrow(/needs a unit/);
		expect(() =>
			registry().declare('agents.core', [
				{ ...RUN_TOKENS, kind: 'counter' as never },
			]),
		).toThrow(/cumulative, gauge/);
	});

	it('refuses more meters than one module may declare', () => {
		const many = Array.from({ length: 65 }, (_entry, index) => ({
			...RUN_TOKENS,
			key: `run-tokens-${index}`,
		}));

		expect(() => registry().declare('agents.core', many)).toThrow(
			/at most 64 are accepted/,
		);
	});
});
