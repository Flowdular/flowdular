import { describe, expect, it } from 'vitest';
import { renderToString } from 'octane/server';
import { ChatPane, type ChatPaneProps } from '../src/client/ChatPane.tsrx';
import { ApprovalHandoff } from '../src/client/ApprovalHandoff.tsrx';
import { SpecEditor } from '../src/client/SpecEditor.tsrx';
import { GateResults } from '../src/client/GateResults.tsrx';
import { SessionBar } from '../src/client/SessionBar.tsrx';
import type { SandboxSession } from '../src/server/sessions.ts';
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
					hash: 'ab12cd34ef56'.padEnd(64, '0'),
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
		/* The card names the exact text the approval applies to: a short form to
		   compare by eye, and the full value to copy. */
		expect(rendered.html).toContain('SHA-256 tego tekstu');
		expect(rendered.html).toContain('>ab12cd34ef56<');
		expect(rendered.html).toContain(
			`title="${'ab12cd34ef56'.padEnd(64, '0')}"`,
		);
		expect(rendered.html).toContain('Kopiuj pełny skrót');
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

describe('session state pill', () => {
	function sessionIn(state: SandboxSession['state']): SandboxSession {
		return {
			id: 'session-1',
			kind: 'new-module',
			moduleId: 'booking.core',
			moduleSuffix: '',
			modules: [{ id: 'booking.core', directory: 'booking', kind: 'new' }],
			title: 'Room booking',
			brief: '',
			blueprint: 'new-module@1.0.0',
			role: 'business-manager',
			driver: 'codex',
			model: null,
			resumeIds: {},
			autoContinue: true,
			chainDepth: 0,
			attachments: [],
			checkpoints: [],
			pendingQuestions: null,
			state,
			createdAt: 1,
			updatedAt: 1,
			ejectedAt: null,
			archivedAt: null,
			registeredWithPlatform: false,
		};
	}
	function pill(state: SandboxSession['state']): string {
		const noop = () => {};
		const html = renderToString(SessionBar, {
			session: sessionIn(state),
			changes: 0,
			busy: false,
			activeModule: '',
			workspaceModules: [],
			onModule: noop,
			onAddModule: noop,
			onBack: noop,
			onGates: noop,
			onChanges: noop,
			onPreview: noop,
			onEject: noop,
		}).html;
		return /<span class="ui-tag[^"]*">[\s\S]*?<\/span>/.exec(html)?.[0] ?? '';
	}

	it('says a session waits on answers, and only an approval says approval', () => {
		registerSandboxTranslations();
		setActiveLocale('en');
		expect(pill('awaiting-answers')).toContain('awaiting answers');
		expect(pill('awaiting-answers')).not.toContain('approval');
		expect(pill('awaiting-answers')).toContain('ui-tag--warning');
		expect(pill('awaiting-approval')).toContain('awaiting approval');
		setActiveLocale('pl');
		expect(pill('awaiting-answers')).toContain('oczekuje na odpowiedzi');
		expect(pill('awaiting-answers')).not.toContain('zatwierdz');
	});
});

describe('transcript entries', () => {
	function transcript(entries: ChatPaneProps['entries']): string {
		const noop = () => {};
		const html = renderToString(ChatPane, {
			entries,
			delivered: false,
			archived: false,
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
		}).html;
		return html.replace(/<!--[\s\S]*?-->/g, '');
	}

	it('shows a failed gate as the errors of its failing reports, the raw output folded away', () => {
		registerSandboxTranslations();
		setActiveLocale('en');
		const message =
			'Field "equipment-item.createdAt" collides with the id, tenantId or createdAt column every tenant table owns.';
		const output = JSON.stringify({
			protocolVersion: 1,
			ok: false,
			error: {
				code: 'SPEC_VALIDATION_FAILED',
				message: 'One or more specifications are invalid.',
				details: {
					reports: [
						{
							file: 'reference/example-module/spec/module.yaml',
							valid: true,
							issues: [],
						},
						{
							file: 'modules/equipment/spec/module.yaml',
							valid: false,
							issues: [
								{
									code: 'SPEC_FIELD_RESERVED',
									message,
									path: '/entities/0/fields/7/id',
									severity: 'error',
								},
							],
						},
					],
				},
			},
		});
		const html = transcript([
			{
				sequence: 63,
				at: 1,
				kind: 'system',
				role: 'business-manager',
				text: `Gate spec-schema failed.\nCommand: pnpm flowdular spec validate --all --json\n\n${output}`,
				gate: {
					id: 'spec-schema',
					status: 'failed',
					issues: [
						{
							file: 'modules/equipment/spec/module.yaml',
							code: 'SPEC_FIELD_RESERVED',
							path: '/entities/0/fields/7/id',
							message,
						},
					],
				},
			},
		]);
		const visible = html.replace(/<details[\s\S]*?<\/details>/g, '');

		expect(visible).toContain('Requirements document');
		expect(visible).toContain('Needs a fix');
		expect(visible).toContain(message);
		expect(visible).toContain('SPEC_FIELD_RESERVED');
		expect(visible).toContain('/entities/0/fields/7/id');
		expect(visible).not.toContain('reference/example-module');
		expect(visible).not.toContain('protocolVersion');
		/* The specialist's view of the same result is still there, folded. */
		expect(html).toMatch(/<details>[\s\S]*protocolVersion[\s\S]*<\/details>/);
	});

});
