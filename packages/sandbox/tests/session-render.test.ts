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
	it('lists the validator errors above the folded raw output', () => {
		registerSandboxTranslations();
		setActiveLocale('en');
		const rendered = renderToString(GateResults, {
			results: [
				{
					id: 'spec-schema',
					status: 'failed',
					durationMs: 1,
					command: 'pnpm --silent flowdular spec validate --all --json',
					output: '{ "protocolVersion": 1, "ok": false }',
					issues: [
						{
							file: 'modules/booking/spec/module.yaml',
							code: 'SPEC_FIELD_RESERVED',
							path: '/entities/0/fields/1/id',
							message: 'Field "booking.createdAt" collides with a column.',
						},
					],
					moreIssues: 2,
				},
			],
			running: false,
			error: '',
			onClose: () => {},
		});
		const html = rendered.html;
		expect(html).toContain('SPEC_FIELD_RESERVED');
		expect(html).toContain('/entities/0/fields/1/id');
		expect(html).toContain('2 more errors are not shown.');
		expect(html.indexOf('SPEC_FIELD_RESERVED')).toBeLessThan(
			html.indexOf('protocolVersion'),
		);
		expect(html).not.toMatch(/<details[^>]*\sopen/);
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

	it('shows an automatic repair message as the errors it sends, not as the operator', () => {
		registerSandboxTranslations();
		setActiveLocale('en');
		const message = `Translation key "page.title" is missing from translations/en.json; the client reads it as t('equipment.page.title').`;
		const html = transcript([
			{
				sequence: 467,
				at: 1,
				kind: 'user',
				role: 'business-manager',
				text: 'Continue as Business manager. The module-schema gate failed.\n\nRecorded gate results:\nmodule-schema: failed',
				instruction: {
					gates: [
						{
							id: 'module-schema',
							status: 'failed',
							issues: [
								{
									file: 'modules/equipment/module.json',
									code: 'TRANSLATION_KEY_MISSING',
									path: 'src/client/EquipmentView.tsrx',
									message,
								},
							],
							moreIssues: 2,
						},
					],
				},
			},
		]);
		const visible = html.replace(/<details[\s\S]*?<\/details>/g, '');

		expect(visible).toContain('Sandbox');
		expect(visible).not.toContain('>You<');
		expect(visible).toContain('Module configuration');
		expect(visible).toContain(message);
		expect(visible).toContain('TRANSLATION_KEY_MISSING');
		expect(visible).toContain('2 more errors are not shown.');
		expect(visible).not.toContain('Recorded gate results');
		expect(html).toMatch(
			/<details>[\s\S]*Recorded gate results[\s\S]*<\/details>/,
		);
	});

	it('formats an agent message without letting its markup through', () => {
		registerSandboxTranslations();
		setActiveLocale('en');
		const html = transcript([
			{
				sequence: 1,
				at: 1,
				kind: 'user',
				role: 'business-manager',
				text: 'Keep **this** as typed.',
			},
			{
				sequence: 2,
				at: 2,
				kind: 'agent',
				role: 'business-manager',
				text: [
					'**Files written**',
					'- `modules/equipment/spec/module.yaml`: the draft',
					'',
					'<img src=x onerror=alert(1)> [run](javascript:alert(1)) [docs](https://example.com/docs)',
					'',
					'HANDOFF: none - done',
				].join('\n'),
			},
		]);

		expect(html).toContain('Keep **this** as typed.');
		expect(html).toContain('<strong>Files written</strong>');
		expect(html).toContain(
			'<li><p><code>modules/equipment/spec/module.yaml</code>: the draft</p></li>',
		);
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('javascript:');
		expect(html).toContain(
			'<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer nofollow">docs</a>',
		);
		expect(html).not.toContain('HANDOFF');
	});

	/* Trimmed from the run 5 auto-review turns: the same prose, fence, check
	   keys, finding format and closing handoff line. */
	const reviewChecks = {
		correctness:
			'Base reference/auto-review-base/ is empty, so the whole module was reviewed as new. EQUIPMENT-CREATE maps to equipment-service.ts:178 and tests/module.test.ts:93.',
		security:
			'Tenant identity comes only from principalFromContext (endpoints.ts:44); endpoints.test.ts:192 asserts 401 and 403 on all five routes.',
		compatibility:
			'module.json id equipment.core 0.1.0 matches package.json 0.1.0 and spec specVersion 0.1.0.',
		lifecycle:
			'Updates and retires lock the row with SELECT ... FOR UPDATE in one write transaction (database-repository.ts:228-263).',
		tests:
			'Suites: tests/module.test.ts, tests/endpoints.test.ts and tests/migrations.test.ts. The tests gate is pending on the current bytes.',
		ui: 'No rendered inspection was possible: this sandbox gives the review no preview. screenState covers loading, denied, error, empty and populated (state.ts:243).',
	};
	function reviewMessage(body: string): string {
		return [
			"I've re-reviewed the whole equipment module and my verdict is **pass**, with no defects found.",
			'',
			'- **Tests on the current files are still pending.** The orchestrator needs to rerun tests before eject.',
			'- **The spec is unchanged** and still approved at its current hash.',
			'',
			'```auto-review',
			body,
			'```',
			'',
			'HANDOFF: none - review passes; the operator still needs to look at the rendered screens',
		].join('\n');
	}
	function reviewEntry(text: string): ChatPaneProps['entries'][number] {
		return {
			sequence: 1429,
			at: 1,
			kind: 'agent',
			role: 'business-manager',
			module: 'equipment',
			text,
		};
	}
	const folded = (html: string) =>
		html.replace(/<details[\s\S]*?<\/details>/g, '');

	it('shows a review verdict as a summary with the report folded away', () => {
		registerSandboxTranslations();
		setActiveLocale('en');
		const html = transcript([
			reviewEntry(
				reviewMessage(
					JSON.stringify(
						{ verdict: 'pass', checks: reviewChecks, findings: [] },
						null,
						2,
					),
				),
			),
		]);
		const visible = folded(html);

		expect(visible).toContain(
			'<strong>Tests on the current files are still pending.</strong>',
		);
		expect(visible).toContain('Passes review');
		for (const check of [
			'Correctness',
			'Security',
			'Compatibility',
			'Lifecycle',
			'Tests',
			'UI',
		])
			expect(visible).toContain(`<span>${check}</span>`);
		expect(visible.match(/Evidence given/g)).toHaveLength(6);
		expect(visible).toContain('No findings.');
		expect(visible).not.toContain('auto-review-base');
		expect(visible).not.toContain('principalFromContext');
		expect(visible).not.toContain('findings&quot;');
		expect(visible).not.toContain('"findings"');
		expect(visible).not.toContain('HANDOFF');
		expect(html).toMatch(
			/<details>\s*<summary>Full review report<\/summary>[\s\S]*auto-review-base[\s\S]*principalFromContext[\s\S]*<\/details>/,
		);
	});

	it('lists each review finding with its severity and file, in Polish too', () => {
		registerSandboxTranslations();
		setActiveLocale('pl');
		const html = transcript([
			reviewEntry(
				reviewMessage(
					JSON.stringify(
						{
							verdict: 'fail',
							checks: { ...reviewChecks, ui: 'Not checked.' },
							findings: [
								'High; modules/equipment/src/client/EquipmentView.tsrx:117-148 and src/client/api.ts:16-23; any list load; the in-repair count the list endpoint answers is discarded and never shown; load and render inRepairCount.',
								'Medium; modules/equipment/tests; no client tests; the UI parts of EQUIPMENT-RETIRE are unverified; add client tests.',
								'The search field has no length limit.',
							],
						},
						null,
						2,
					),
				),
			),
		]);
		const visible = folded(html);

		expect(visible).toContain('Wymaga poprawek');
		expect(visible.match(/Z dowodami/g)).toHaveLength(5);
		expect(visible.match(/Bez dowodów/g)).toHaveLength(1);
		expect(visible).toContain('Wysoka');
		expect(visible).toContain('Średnia');
		expect(visible).toContain(
			'modules/equipment/src/client/EquipmentView.tsrx:117-148 and src/client/api.ts:16-23',
		);
		expect(visible).toContain(
			'any list load; the in-repair count the list endpoint answers is discarded and never shown; load and render inRepairCount.',
		);
		expect(visible).toContain('The search field has no length limit.');
		expect(visible).not.toContain('High;');
		expect(visible).not.toContain('auto-review-base');
		expect(html).toMatch(/<details>[\s\S]*auto-review-base[\s\S]*<\/details>/);
		setActiveLocale('en');
	});

	it('renders a review block that is not a verdict as before', () => {
		registerSandboxTranslations();
		setActiveLocale('en');
		const malformed = JSON.stringify(
			{ verdict: 'pass', checks: reviewChecks, findings: [] },
			null,
			2,
		).slice(0, 200);
		for (const body of [
			malformed,
			JSON.stringify({ verdict: 'maybe', checks: reviewChecks, findings: [] }),
		]) {
			const html = transcript([reviewEntry(reviewMessage(body))]);
			const visible = folded(html);

			expect(visible).toContain('<pre class="ui-code">');
			expect(visible).toContain('auto-review-base');
			expect(visible).toContain(
				'<strong>Tests on the current files are still pending.</strong>',
			);
			expect(visible).not.toContain('Evidence given');
			expect(html).not.toContain('Full review report');
			expect(visible).not.toContain('HANDOFF');
		}
	});

	it('keeps a long activity line whole for the ellipsis and its title', () => {
		registerSandboxTranslations();
		setActiveLocale('en');
		const reasoning = `${'The spec leaves the category open, '.repeat(5)}so I will draft the spec using platform and recommended defaults.`;
		const html = transcript([
			{
				sequence: 1,
				at: 1,
				kind: 'event',
				role: 'business-manager',
				event: { type: 'reasoning', text: reasoning },
			},
		]);

		expect(reasoning.length).toBeGreaterThan(160);
		expect(html).toContain(`title="${reasoning}"`);
		expect(html).toContain(
			`<span class="chat__event-text">${reasoning}</span>`,
		);
	});
});
