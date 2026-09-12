import { describe, expect, it } from 'vitest';
import {
	incrementModuleVersion,
	retargetModuleRange,
} from '../src/module-compatibility.ts';

describe('incrementModuleVersion', () => {
	it('bumps each level', () => {
		expect(incrementModuleVersion('0.11.0', 'patch')).toBe('0.11.1');
		expect(incrementModuleVersion('0.11.0', 'minor')).toBe('0.12.0');
		expect(incrementModuleVersion('0.11.0', 'major')).toBe('1.0.0');
	});

	it('refuses an invalid version', () => {
		expect(() => incrementModuleVersion('next', 'patch')).toThrow(
			/invalid version/,
		);
	});
});

describe('retargetModuleRange', () => {
	it('keeps a range that still accepts the version', () => {
		expect(retargetModuleRange('^0.11.0', '0.11.4')).toBe('^0.11.0');
		expect(retargetModuleRange('~0.11.0', '0.11.1')).toBe('~0.11.0');
		expect(retargetModuleRange('^1.2.0', '1.9.0')).toBe('^1.2.0');
	});

	it('moves the version and keeps the operator when the range excludes it', () => {
		expect(retargetModuleRange('^0.11.0', '0.12.0')).toBe('^0.12.0');
		expect(retargetModuleRange('~0.11.0', '0.12.0')).toBe('~0.12.0');
		expect(retargetModuleRange('0.11.0', '0.11.1')).toBe('0.11.1');
	});

	it('leaves compound ranges to the caller', () => {
		expect(retargetModuleRange('>=0.11.0 <0.12.0', '0.12.0')).toBeNull();
	});
});
