import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/* The kernel barrel is imported by module client code, and in development
   Vite evaluates every file it reaches in the browser. A named import from a
   Node built-in is rewritten to a property read of the browser shim and throws
   at module evaluation; a namespace import throws only when a function is
   called. This walks the graph behind index.ts and refuses the named form. */
const root = resolve(import.meta.dirname, '../src');
/** Packages the barrel may pull into a browser: ES modules, no Node built-ins. */
const BROWSER_SAFE_PACKAGES: readonly string[] = ['@flowdular/contracts'];
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
		/* A package the browser graph reaches is served as it is published. A
		   CommonJS one (semver was) stops a generated application at bootstrap,
		   so the barrel depends on browser-safe packages only. */
		if (
			!specifier!.startsWith('.') &&
			!specifier!.startsWith('node:') &&
			!clause!.startsWith('type ')
		) {
			expect(
				BROWSER_SAFE_PACKAGES,
				`${file.slice(root.length + 1)} imports ${specifier}; keep it out of the barrel or add it to BROWSER_SAFE_PACKAGES once it ships browser-loadable ES modules`,
			).toContain(specifier);
		}
	}
	for (const match of source.matchAll(
		/export\s+\{[^}]*\}\s+from\s+'(\.[^']+)';/g,
	)) {
		walk(resolve(dirname(file), match[1]!), seen);
	}
}

describe('kernel barrel', () => {
	it('loads in a browser: no Node built-in by name, no package a browser cannot load', () => {
		const seen = new Set<string>();
		walk(resolve(root, 'index.ts'), seen);
		expect(seen.size).toBeGreaterThan(10);
	});
});
