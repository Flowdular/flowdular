import { describe, expect, it } from 'vitest';
import type { ModuleManifest } from '@flowdular/contracts';
import {
	assertModuleCompatibility,
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

describe('assertModuleCompatibility', () => {
	function manifest(platformApi?: string): ModuleManifest {
		return {
			schemaVersion: 1,
			id: 'notes.core',
			package: '@flowdular/module-notes',
			version: '0.1.0',
			profile: 'full',
			capabilities: [],
			dependencies: [],
			tenancy: 'required',
			locales: ['en'],
			stability: 'experimental',
			...(platformApi === undefined ? {} : { platformApi }),
		};
	}

	it('accepts a range that starts at the platform line', () => {
		for (const range of [
			'^0.2.0',
			'~0.2.0',
			'>=0.2.0',
			'>=0.2.0 <0.3.0',
			'>=0.1.0 >=0.2.0',
			'>0.1.9 >=0.2.1',
		])
			expect(() =>
				assertModuleCompatibility(manifest(range), '0.2.3'),
			).not.toThrow();
	});

	it('refuses a manifest without platformApi', () => {
		expect(() => assertModuleCompatibility(manifest(), '0.2.0')).toThrowError(
			expect.objectContaining({ code: 'MODULE_PLATFORM_REQUIRED' }),
		);
		expect(() => assertModuleCompatibility(manifest(), null)).toThrowError(
			expect.objectContaining({ code: 'MODULE_PLATFORM_REQUIRED' }),
		);
	});

	/* 0.2 renamed the secret and read-permission markers. A range that still
	   admits 0.1 describes a module whose marked fields the platform ignores. */
	it('refuses a range that also admits an older platform line', () => {
		for (const range of [
			'*',
			'>=0.1.0',
			'<1.0.0',
			'^0.1.0 || ^0.2.0',
			'<0.2.0 || ^0.2.0',
			'>0.1.9',
		])
			expect(
				() => assertModuleCompatibility(manifest(range), '0.2.3'),
				range,
			).toThrowError(
				expect.objectContaining({
					code: 'MODULE_PLATFORM_INCOMPATIBLE',
					message: expect.stringContaining('^0.2.0'),
				}),
			);
	});

	it('leaves the line to the caller that names no platform version', () => {
		expect(() =>
			assertModuleCompatibility(manifest('^0.1.0'), null),
		).not.toThrow();
	});
});
