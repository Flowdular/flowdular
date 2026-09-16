import { describe, expect, it } from 'vitest';
import { blockedAddress } from '../src/services/outbound-policy.ts';

describe('AGENTS-PROVIDER-ADDRESS-BLOCK outbound address block', () => {
	it.each([
		'127.0.0.1',
		'10.1.2.3',
		'100.64.0.1',
		'192.0.2.1',
		'198.18.0.1',
		'198.19.255.255',
		'198.51.100.7',
		'203.0.113.9',
		'::',
		'::1',
		'::127.0.0.1',
		'::ffff:127.0.0.1',
		'::ffff:7f00:1',
		'64:ff9b::7f00:1',
		'64:ff9b::10.0.0.1',
		'64:ff9b:1::1',
		'2002:7f00:1::',
		'2002:a00:1::',
		'2001::1',
		'2001:db8::1',
		'100::1',
		'fc00::1',
		'fd12::1',
		'fe80::1',
		'fec0::1',
		'ff02::1',
	])('refuses %s, including IPv4 carried inside IPv6', (address) => {
		expect(blockedAddress(address)).toBe(true);
	});

	it.each([
		'8.8.8.8',
		'1.1.1.1',
		'::ffff:8.8.8.8',
		'64:ff9b::808:808',
		'2002:808:808::',
		'2606:4700:4700::1111',
		'2a00:1450:4001:80b::200e',
	])('allows the public address %s', (address) => {
		expect(blockedAddress(address)).toBe(false);
	});
});
