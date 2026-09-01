import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_AGENT_ROLES,
	SANDBOX_ROLE_DIRECTORY,
	loadRoleDocuments,
	normalizeRoleDocument,
	parseRoleDocument,
	renderDefaultsModule,
} from '../src/index.ts';

async function workspaceRoot(): Promise<string> {
	let directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
	for (;;) {
		try {
			await access(join(directory, 'coreloom.json'));
			return directory;
		} catch {
			const parent = dirname(directory);
			if (parent === directory) throw new Error('No coreloom.json found.');
			directory = parent;
		}
	}
}

describe('role sync', () => {
	it('keeps the bundled defaults identical to the workspace role documents', async () => {
		const documents = await loadRoleDocuments(
			join(await workspaceRoot(), SANDBOX_ROLE_DIRECTORY),
		);
		expect(documents).toEqual(
			[...DEFAULT_AGENT_ROLES].sort((left, right) =>
				left.id.localeCompare(right.id),
			),
		);
	});

	it('strips the markdown escapes prettier adds to a document', () => {
		const role = normalizeRoleDocument(
			parseRoleDocument(
				'---\nid: x\nname: X\npurpose: P\n---\n\nNever restyle a ui-\\* class or \\_private names.\n',
			),
		);
		expect(role.instruction).toBe(
			'Never restyle a ui-* class or _private names.',
		);
	});

	it('renders a module whose roles survive a round trip through the source', () => {
		const source = renderDefaultsModule(DEFAULT_AGENT_ROLES);
		expect(source).toContain('GENERATED from .ai/agents/sandbox');
		for (const role of DEFAULT_AGENT_ROLES) {
			expect(source).toContain(`id: '${role.id}'`);
		}
		expect(source).not.toMatch(/[–—]/);
	});
});
