import { describe, expect, it } from 'vitest';
import { renderToString } from 'octane/server';
import { ChatPane, type ChatPaneProps } from '../src/client/ChatPane.tsrx';
import { ApprovalHandoff } from '../src/client/ApprovalHandoff.tsrx';
import { SpecEditor } from '../src/client/SpecEditor.tsrx';
import { GateResults } from '../src/client/GateResults.tsrx';
import {
	registerSandboxTranslations,
	setActiveLocale,
} from '../src/client/i18n.ts';

describe('session approval rendering', () => {
	it('does not offer approval when the target specification cannot be read', () => {
		registerSandboxTranslations();
		setActiveLocale('pl');
		const rendered = renderToString(ApprovalHandoff, {
			handoff: {
				kind: 'approval',
				role: 'backend-engineer',
				roleName: 'Backend engineer',
				prompt: '',
				reason: '',
				module: 'missing',
			},
			reviews: [],
			busy: false,
			onApprove: () => {},
			onRequestChanges: () => {},
			onEdit: () => {},
		});
		expect(rendered.html).toContain(
			'Nie można odczytać właściwej specyfikacji',
		);
		expect(rendered.html).not.toContain('<button');
	});
	it('keeps the specification blank and unsavable until its document loads', () => {
		registerSandboxTranslations();
		setActiveLocale('pl');
		const rendered = renderToString(SpecEditor, {
			sessionId: 'session',
			module: 'rooms',
			onSaved: () => {},
		});
		expect(rendered.html).toContain('modules/rooms/spec/module.yaml');
		expect(rendered.html).toContain('Wczytywanie specyfikacji');
		expect(rendered.html).toMatch(/<button[^>]*disabled/);
		expect(rendered.html).toMatch(/<textarea[^>]*disabled[^>]*><\/textarea>/);
	});
	it('renders per-module failures and their diagnostic output', () => {
		registerSandboxTranslations();
		setActiveLocale('pl');
		const rendered = renderToString(GateResults, {
			results: [
				{
					id: 'tests',
					module: 'rooms',
					status: 'failed',
					durationMs: 1,
					command: 'vitest',
					output: 'Overlapping reservation',
				},
			],
			running: false,
			error: '',
			onClose: () => {},
		});
		expect(rendered.html).toContain('Wymaga poprawy');
		expect(rendered.html).toContain('rooms');
		expect(rendered.html).toContain('Overlapping reservation');
	});
	it('renders an approval action in the latest pending handoff', () => {
		registerSandboxTranslations();
		setActiveLocale('pl');
		const noop = () => {};
		const props: ChatPaneProps = {
			entries: [
				{
					sequence: 1,
					at: 1,
					kind: 'system',
					role: 'backend-engineer',
					handoff: {
						kind: 'approval',
						role: 'backend-engineer',
						roleName: 'Backend engineer',
						prompt: 'Implement',
						reason: 'Approve',
						module: 'booking',
					},
				},
			],
			delivered: false,
			archived: false,
			roles: [],
			drivers: [],
			modules: [],
			specs: [
				{
					module: 'booking',
					moduleId: 'booking.core',
					kind: 'new',
					path: 'modules/booking/spec/module.yaml',
					present: true,
					status: 'draft',
					approved: false,
					approvedAt: null,
					changed: true,
					base: null,
					changes: [],
					draft: {
						id: 'booking.core',
						name: 'Rezerwacje',
						description: 'Plan rezerwacji',
						specVersion: '0.1.0',
						status: 'draft',
						profile: 'business',
						tenancy: 'tenant',
						capabilities: [],
						locales: ['pl', 'en'],
						dependencies: [],
						invariants: [],
						dataOwnership: [],
						permissions: [],
						acceptanceScenarios: [],
					},
				},
			],
			role: 'auto',
			module: '',
			driver: '',
			message: '',
			running: false,
			selection: null,
			autoContinue: false,
			pendingQuestions: null,
			answersError: '',
			pendingBrief: '',
			onStart: noop,
			onContinue: noop,
			onApprove: noop,
			onRequestChanges: noop,
			onEditSpec: noop,
			onAutoContinue: noop,
			onRole: noop,
			onModule: noop,
			onDriver: noop,
			onMessage: noop,
			onSend: noop,
			onAnswers: noop,
			onStop: noop,
			onClearSelection: noop,
		};
		const rendered = renderToString(ChatPane, props);
		expect(rendered.html).toContain('Zatwierdź');
		expect(rendered.html).toContain('Plan rezerwacji');
		expect(rendered.html).toContain('Edytuj specyfikację');
	});
	it('answers nothing in an archived session that still has open questions', () => {
		registerSandboxTranslations();
		setActiveLocale('en');
		const noop = () => {};
		const props: ChatPaneProps = {
			entries: [
				{
					sequence: 4,
					at: 1,
					kind: 'system',
					role: 'business-manager',
					handoff: {
						kind: 'question',
						role: 'business-manager',
						roleName: 'Business manager',
						prompt: '',
						reason: 'Two decisions',
						module: 'booking',
					},
				},
			],
			delivered: false,
			archived: true,
			roles: [],
			drivers: [],
			modules: [],
			specs: [],
			role: 'auto',
			module: '',
			driver: '',
			message: '',
			running: false,
			selection: null,
			autoContinue: false,
			pendingQuestions: {
				sequence: 4,
				role: 'business-manager',
				module: 'booking',
				askedAt: 1,
				questions: [
					{
						id: 'Q-1',
						question: 'Who may cancel a booking?',
						options: ['Only the owner', 'Any team member'],
						allowFreeText: false,
					},
				],
			},
			answersError: '',
			pendingBrief: '',
			onStart: noop,
			onContinue: noop,
			onApprove: noop,
			onRequestChanges: noop,
			onEditSpec: noop,
			onAutoContinue: noop,
			onRole: noop,
			onModule: noop,
			onDriver: noop,
			onMessage: noop,
			onSend: noop,
			onAnswers: noop,
			onStop: noop,
			onClearSelection: noop,
		};
		const rendered = renderToString(ChatPane, props);
		expect(rendered.html).toContain('no longer accepts decisions');
		expect(rendered.html).not.toContain('type="radio"');
		expect(rendered.html).not.toContain('Send decisions');
	});
});
