import { describe, expect, it } from 'vitest';
import { ToastHost } from '../src/components/ToastHost.tsrx';
import { createToastStore } from '../src/components/toast-store.ts';
import { mount, run, text } from './dom.ts';

describe('ToastHost', () => {
	it(
		'keeps the live region while empty and announces what the store holds',
		async () => {
			const store = createToastStore({ durationMs: 0 });
			const mounted = await mount(
				<ToastHost label="Notifications" closeLabel="Dismiss" store={store} />,
			);
			const region = mounted.container.querySelector('.ui-toasts');
			expect(region?.getAttribute('role')).toBe('region');
			expect(region?.getAttribute('aria-live')).toBe('polite');
			expect(region?.getAttribute('aria-label')).toBe('Notifications');
			expect(mounted.container.querySelectorAll('.ui-toast')).toHaveLength(0);

			await run(() => {
				store.success('Member invited');
				store.info('Import queued');
			});
			const toasts = Array.from(
				mounted.container.querySelectorAll('.ui-toast'),
			);
			expect(toasts.map((toast) => text(toast))).toEqual([
				'Member invited',
				'Import queued',
			]);
			expect(toasts[0]?.classList.contains('ui-toast--success')).toBe(true);
			expect(toasts[1]?.classList.contains('ui-toast--info')).toBe(true);

			await run(() => {
				(mounted.container.querySelector(
					'.ui-toast__close',
				) as HTMLButtonElement).click();
			});
			expect(
				Array.from(mounted.container.querySelectorAll('.ui-toast')).map(
					(toast) => text(toast),
				),
			).toEqual(['Import queued']);
			expect(mounted.container.querySelector('.ui-toasts')).not.toBeNull();
			mounted.unmount();
		},
	);
});
