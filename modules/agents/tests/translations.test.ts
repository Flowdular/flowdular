import { describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@coreloom/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	cadenceLabel,
	RUN_STATUSES,
	RUN_TRIGGERS,
	timestampLabel,
	type ModelReadinessState,
} from '../src/client/presentation.ts';
import { AGENT_CONTEXT_VARIABLES } from '../src/domain/context-variables.ts';
import type {
	AgentProviderKind,
	AgentSkillStatus,
	AgentStatus,
} from '../src/domain/types.ts';

const PROVIDER_KINDS: Readonly<Record<AgentProviderKind, true>> = {
	'local-simulation': true,
	vercel: true,
	azure: true,
	openai: true,
	'openai-compatible': true,
	anthropic: true,
};

const DEFINITION_STATES: Readonly<
	Record<AgentStatus | AgentSkillStatus | 'disabled', true>
> = {
	draft: true,
	active: true,
	paused: true,
	archived: true,
	disabled: true,
};

const MODEL_STATES: Readonly<Record<ModelReadinessState, true>> = {
	ready: true,
	stale: true,
	failing: true,
	untested: true,
};

describe('agents translations', () => {
	it('registers lifecycle actions under the agents namespace', () => {
		setActiveLocale('en');
		registerModuleTranslations([
			{
				moduleId: 'agents.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		expect(t('agents.common.delete')).toBe('Delete');
		expect(t('agents.definitions.lifecycle.archive.confirm')).toBe(
			'Archive agent',
		);
	});

	it('ships the same keys in English and Polish', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
	});

	it('translates the variable picker and every context variable label', () => {
		registerModuleTranslations([
			{
				moduleId: 'agents.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const key of [
				'agents.template.insert',
				'agents.template.available',
				'agents.template.empty',
				...AGENT_CONTEXT_VARIABLES.map(
					(variable) => 'agents.variables.' + variable.key + '.label',
				),
			]) {
				expect(t(key)).not.toBe(key);
			}
		}
		setActiveLocale('en');
	});

	it('covers each dynamic cadence key and formats timestamps in the active locale', () => {
		setActiveLocale('pl');
		for (const status of RUN_STATUSES) {
			expect(t('agents.runStatus.' + status)).not.toMatch(/^agents\./);
		}
		for (const trigger of RUN_TRIGGERS) {
			expect(t('agents.trigger.' + trigger)).not.toMatch(/^agents\./);
		}
		expect(cadenceLabel(30)).toBe('Co 30 min');
		expect(cadenceLabel(1_440)).toBe('Codziennie');
		expect(cadenceLabel(2_880)).toBe('Co 2 dni');
		expect(cadenceLabel(60)).toBe('Co godzinę');
		expect(cadenceLabel(180)).toBe('Co 3 godz.');
		expect(cadenceLabel(90)).toBe('Co 1 godz. 30 min');
		expect(timestampLabel(0)).not.toContain('Jan');
		setActiveLocale('en');
	});

	it('covers every dynamic provider, lifecycle, and timeline key', () => {
		registerModuleTranslations([
			{
				moduleId: 'agents.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const state of ['unconfigured', 'unavailable']) {
				const key = 'agents.status.' + state;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const kind of Object.keys(PROVIDER_KINDS)) {
				const key = 'agents.providers.kind.' + kind;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const state of ['disabled', 'ready', 'stale', 'untested']) {
				const key = 'agents.providers.status.' + state;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const state of Object.keys(MODEL_STATES)) {
				const key = 'agents.providers.modelStatus.' + state;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const state of Object.keys(DEFINITION_STATES)) {
				const key = 'agents.status.' + state;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const entity of ['definitions', 'skills']) {
				for (const action of ['archive', 'delete']) {
					for (const part of ['title', 'confirm', 'description']) {
						const key = `agents.${entity}.lifecycle.${action}.${part}`;
						expect(t(key), `${locale}: ${key}`).not.toBe(key);
					}
				}
			}
			for (const state of ['started', 'completed', 'failed', 'denied']) {
				const key = 'agents.timeline.tool.' + state;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
		setActiveLocale('en');
	});
});
