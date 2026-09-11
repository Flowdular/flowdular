import { describe, expect, it } from 'vitest';
import { renderBrandHeader } from '../src/brand.mjs';

describe('terminal brand header', () => {
	it('keeps redirected output compact and undecorated', () => {
		const output = renderBrandHeader({
			title: 'FLOWDULAR SANDBOX',
			subtitle: 'agentic workspace',
			terminal: false,
		});
		expect(output).toBe('  FLOWDULAR SANDBOX  agentic workspace');
		expect(output).not.toContain('\u001b');
	});
	it('uses ASCII within the terminal width and keeps the brand readable without color', () => {
		const output = renderBrandHeader({
			title: 'FLOWDULAR SANDBOX',
			subtitle: 'agentic workspace',
			terminal: true,
			columns: 80,
		});
		expect(output).toContain('XXX');
		expect(output).toContain('FLOWDULAR SANDBOX');
		expect(output).toMatch(/^[\x20-\x7e\n]+$/);
		expect(output.split('\n').every((line) => line.length <= 80)).toBe(true);
	});
	it('stacks the logo and captions in a narrow terminal', () => {
		const output = renderBrandHeader({
			title: 'FLOWDULAR',
			subtitle: 'development workspace',
			terminal: true,
			columns: 32,
		});
		expect(output).toContain('XXX');
		expect(output).toContain('\n\n  FLOWDULAR\n  development workspace');
		expect(output).toContain('development workspace');
		expect(output.split('\n').every((line) => line.length <= 32)).toBe(true);
	});
});
