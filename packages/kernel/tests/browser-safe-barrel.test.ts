import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/* The kernel barrel is imported by module client code, and in development
   Vite evaluates every file it reaches in the browser. A named import from a
   Node built-in is rewritten to a property read of the browser shim and throws
   at module evaluation; a namespace import throws only when a function is
   called. This walks the graph behind index.ts and refuses the named form. */
const root = resolve(import.meta.dirname, '../src');
const importPattern = /import\s+([^'";]+?)\s+from\s+'([^']+)';/g;

function walk(file: string, seen: Set<string>): void {
	if (seen.has(file)) return;
	seen.add(file);
	const source = readFileSync(file, 'utf8');
	for (const match of source.matchAll(importPattern)) {
		const [, clause, specifier] = match;
		if (specifier!.startsWith('./') || specifier!.startsWith('../')) {
			walk(resolve(dirname(file), specifier!), seen);
		}
		if (specifier!.startsWith('node:') && !clause!.startsWith('type ')) {
			expect(
				clause!.startsWith('* as '),
				`${file.slice(root.length + 1)} imports ${specifier} by name; use a namespace import and touch it only inside functions`,
			).toBe(true);
		}
	}
	for (const match of source.matchAll(
		/export\s+\{[^}]*\}\s+from\s+'(\.[^']+)';/g,
	)) {
		walk(resolve(dirname(file), match[1]!), seen);
	}
}

describe('kernel barrel', () => {
	it('loads in a browser: no named import from a Node built-in behind index.ts', () => {
		const seen = new Set<string>();
		walk(resolve(root, 'index.ts'), seen);
		expect(seen.size).toBeGreaterThan(10);
	});
});
