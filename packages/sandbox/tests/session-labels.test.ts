import { describe, expect, it } from 'vitest';
import {
	registerSandboxTranslations,
	setActiveLocale,
	t,
} from '../src/client/i18n.ts';
import {
	DELIVERY_STEPS,
	deliveryStepDetail,
	deliveryStepLabel,
	gateLabel,
	handoffLabel,
	roleLabel,
} from '../src/client/session-labels.ts';

describe('session labels', () => {
	it('changes role, delivery and gate labels when the locale changes', () => {
		registerSandboxTranslations();
		const step = {
			id: 'copy',
			label: 'Copy files',
			detail: '2 files',
			files: 2,
			status: 'passed' as const,
		};
		setActiveLocale('pl');
		expect(roleLabel('backend-engineer')).toBe('Reguły biznesowe i dane');
		expect(gateLabel('tests')).toBe('Testy działania');
		expect(deliveryStepLabel(step)).toBe('Przenoszenie modułu do platformy');
		expect(deliveryStepDetail(step)).toBe('2 plików');
		setActiveLocale('en');
		expect(deliveryStepLabel(step)).toBe('Copy the module into the workspace');
		expect(deliveryStepDetail(step)).toBe('2 files');
	});
	it('translates every structured stage in both locales without translating custom identifiers', () => {
		registerSandboxTranslations();
		for (const locale of ['pl', 'en']) {
			setActiveLocale(locale);
			for (const id of DELIVERY_STEPS) {
				expect(
					deliveryStepLabel({ id, label: id, detail: '', status: 'running' }),
				).not.toMatch(/^sandbox\./);
			}
			for (const kind of [
				'approval',
				'continue',
				'question',
				'review',
				'blocked',
			] as const) {
				expect(
					handoffLabel({
						kind,
						role: 'custom',
						roleName: 'Custom',
						reason: '',
						prompt: '',
					}),
				).not.toMatch(/^sandbox\./);
			}
			for (const status of ['passed', 'failed', 'skipped']) {
				const key = 'sandbox.gates.status.' + status;
				expect(t(key)).not.toBe(key);
			}
			expect(roleLabel('my-specialist', 'My specialist')).toBe('My specialist');
			expect(gateLabel('custom-check')).toBe('custom-check');
		}
	});
});
