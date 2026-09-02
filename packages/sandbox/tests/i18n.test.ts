import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxSessionState } from '../src/server/sessions.ts';
import en from '../src/client/locales/en.json';
import pl from '../src/client/locales/pl.json';
import {
	registerSandboxTranslations,
	setActiveLocale,
	t,
} from '../src/client/i18n.ts';
import { registerModuleTranslations } from '@coreloom/client/i18n';

const SESSION_STATES: Readonly<Record<SandboxSessionState, true>> = {
	draft: true,
	classified: true,
	planned: true,
	editing: true,
	validating: true,
	previewing: true,
	'awaiting-approval': true,
	accepted: true,
	failed: true,
	blocked: true,
	deleted: true,
};

const SPEC_FIELD_LABELS = [
	'id',
	'version',
	'status',
	'name',
	'description',
	'profile',
	'tenancy',
	'capability',
	'locale',
	'dependency',
	'invariant',
	'dataOwnership',
	'permission',
	'scenario',
] as const;

function expectTranslated(key: string): void {
	expect(t(key), key).not.toBe(key);
}

function sourceFiles(directory: string): readonly string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return ['.ts', '.tsrx'].includes(extname(entry.name)) ? [path] : [];
	});
}

function staticSandboxKeys(): readonly string[] {
	const directory = fileURLToPath(new URL('../src', import.meta.url));
	const pattern = /\bt\(\s*['"]([^'"]+)['"]/g;
	const keys = new Set<string>();
	for (const file of sourceFiles(directory)) {
		const source = readFileSync(file, 'utf8');
		for (const match of source.matchAll(pattern)) {
			const key = match[1] ?? '';
			if (key.startsWith('sandbox.') && !key.endsWith('.')) keys.add(key);
		}
	}
	return [...keys].sort();
}

describe('sandbox translations', () => {
	it('reinstalls its bundle after the shared catalog is rebuilt', () => {
		registerSandboxTranslations();
		setActiveLocale('en');
		expect(t('sandbox.workspace.language.en')).toBe('English');

		registerModuleTranslations([]);
		expect(t('sandbox.workspace.language.en')).toBe(
			'sandbox.workspace.language.en',
		);

		registerSandboxTranslations();
		expect(t('sandbox.workspace.language.en')).toBe('English');
	});

	it('ships matching English and Polish bundles', () => {
		expect(Object.keys(pl).sort()).toEqual(Object.keys(en).sort());
	});

	it('contains every statically referenced standalone key', () => {
		registerSandboxTranslations();
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const key of staticSandboxKeys()) expectTranslated(key);
		}
		setActiveLocale('en');
	});

	it('resolves every dynamic key family in both locales', () => {
		registerSandboxTranslations();
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const state of [...Object.keys(SESSION_STATES), 'delivered']) {
				expectTranslated('sandbox.session.state.' + state);
			}
			for (const language of ['en', 'pl']) {
				expectTranslated('sandbox.workspace.language.' + language);
			}
			for (const field of SPEC_FIELD_LABELS) {
				expectTranslated('sandbox.spec.field.' + field);
			}
			for (const change of ['created', 'modified', 'deleted']) {
				expectTranslated('sandbox.diff.change.' + change);
			}
			for (const target of ['target.workspace', 'target.gitPr']) {
				expectTranslated('sandbox.eject.' + target);
			}
			for (const count of ['one', 'other']) {
				expectTranslated('sandbox.eject.deliveredVerb.' + count);
			}
		}
		setActiveLocale('en');
	});
});
