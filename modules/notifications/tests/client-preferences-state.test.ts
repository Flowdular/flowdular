import { describe, expect, it } from 'vitest';
import {
	emailDeliverySwitchState,
	type ScreenStatus,
} from '../src/client/state.ts';

const MANAGED = { canManage: true, busy: false };

describe('preferences e-mail switch', () => {
	/* Nothing is stored for a member who never opened the screen, so the loaded
	   answer is the only one the switch may show: rendered before the load
	   answers, or after one that failed, it shows the store's own `false` as the
	   member's answer and writes it back on the first click. */
	it('is part of the screen only once the member settings loaded', () => {
		expect(emailDeliverySwitchState({ status: 'idle', ...MANAGED })).toEqual({
			shown: true,
			disabled: false,
		});
		for (const status of [
			'loading',
			'error',
			'denied',
			'submitting',
		] as ScreenStatus[]) {
			expect([
				status,
				emailDeliverySwitchState({ status, ...MANAGED }),
			]).toEqual([status, { shown: false, disabled: true }]);
		}
	});

	it('is read-only without the permission and while a save is in flight', () => {
		expect(
			emailDeliverySwitchState({
				status: 'idle',
				canManage: false,
				busy: false,
			}),
		).toEqual({ shown: true, disabled: true });
		expect(
			emailDeliverySwitchState({ status: 'idle', canManage: true, busy: true }),
		).toEqual({ shown: true, disabled: true });
	});
});
