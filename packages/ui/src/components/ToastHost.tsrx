import { useSyncExternalStore } from 'octane';
import { Icon } from '../icons/Icon.tsrx';
import { toasts, type ToastStore, type ToastTone } from './toast-store.ts';

export interface ToastHostProps {
	/** Accessible name of the live region, e.g. 'Notifications'. */
	readonly label: string;
	readonly closeLabel: string;
	/** Defaults to the shared queue; pass one to scope a surface or a test. */
	readonly store?: ToastStore | undefined;
}

const TONE_ICONS: Readonly<Record<ToastTone, string>> = {
	success: 'check',
	error: 'alert',
	info: 'info',
};

/**
 * Renders the toast queue. One host per screen that raises toasts; the region
 * stays in the DOM while it is empty, because a live region added together
 * with its first message is not announced.
 */
export function ToastHost(props: ToastHostProps) @{
	const store = props.store ?? toasts;
	const items = useSyncExternalStore(store.subscribe, store.list, store.list);
	<div
		class="ui-toasts"
		role="region"
		aria-label={props.label}
		aria-live="polite"
	>
		@for (const toast of items; key toast.id) {
			<div class={['ui-toast', 'ui-toast--' + toast.tone]}>
				<Icon name={TONE_ICONS[toast.tone]} size={16} />
				<span class="ui-toast__message">{toast.message}</span>
				<button
					class="ui-toast__close"
					type="button"
					aria-label={props.closeLabel}
					onClick={() => store.dismiss(toast.id)}
				>
					<Icon name="x" size={14} />
				</button>
			</div>
		}
	</div>
}
