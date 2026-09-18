import { beforeEach, describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@flowdular/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import { AGENT_PERMISSIONS } from '../src/acl/permissions.ts';
import {
	ASSISTANT_TOPBAR_WIDGET,
	launcherState,
	pendingTurn,
} from '../src/client/assistant-state.ts';
import type {
	AssistantConversation,
	AssistantReadiness,
	AssistantTurn,
} from '../src/domain/types.ts';

function readiness(
	patch: Partial<AssistantReadiness> = {},
): AssistantReadiness {
	return {
		enabled: true,
		permitted: true,
		providerReady: true,
		bindingConfigured: true,
		ready: true,
		agentId: 'agents.core.assistant',
		configureHref: null,
		lockedReason: null,
		...patch,
	};
}

function conversation(
	...statuses: readonly AssistantTurn['status'][]
): AssistantConversation {
	return {
		thread: { id: 'thread-1' } as AssistantConversation['thread'],
		turns: statuses.map(
			(status, index) => ({ id: 'turn-' + index, status }) as AssistantTurn,
		),
	};
}

describe('assistant header entry', () => {
	it('reads locked until the assistant can actually answer', () => {
		expect(launcherState(null, false)).toBe('locked');
		expect(
			launcherState(
				readiness({
					ready: false,
					providerReady: false,
					lockedReason: 'provider-missing',
					configureHref: '/agent-providers',
				}),
				false,
			),
		).toBe('locked');
		/* A turn queued before the workspace switched the assistant off still
		   reads as locked: the entry reports readiness first. */
		expect(launcherState(readiness({ ready: false }), true)).toBe('locked');
	});

	it('reports a turn in flight and settles back to ready', () => {
		expect(launcherState(readiness(), true)).toBe('working');
		expect(launcherState(readiness(), false)).toBe('ready');
	});

	it('waits only while a turn of the open conversation is pending', () => {
		expect(pendingTurn(null)).toBe(false);
		expect(pendingTurn(conversation('answered', 'failed'))).toBe(false);
		expect(pendingTurn(conversation('answered', 'pending'))).toBe(true);
	});

	it('puts the entry in the topbar behind the assistant permission', () => {
		expect(ASSISTANT_TOPBAR_WIDGET).toEqual({
			id: 'agents.topbar.assistant',
			slot: 'topbar.actions',
			scope: AGENT_PERMISSIONS.assistantUse,
			order: 20,
		});
	});
});

describe('assistant copy', () => {
	beforeEach(() => {
		registerModuleTranslations([
			{
				moduleId: 'agents.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		setActiveLocale('en');
	});

	/* The locked screen builds its step keys from the step name, so the literal
	   scan in translations.test.ts cannot see them. */
	it('names both configuration steps in every locale', () => {
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const step of ['provider', 'binding']) {
				const key = 'agents.assistant.locked.step.' + step;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
	});
});
