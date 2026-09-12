export type ToastTone = 'success' | 'error' | 'info';

export interface Toast {
	readonly id: string;
	readonly tone: ToastTone;
	readonly message: string;
}

export interface ToastStoreOptions {
	/** Milliseconds before a toast removes itself; 0 keeps it until closed. */
	readonly durationMs?: number | undefined;
	/** Newest toasts kept at once. Older ones are dropped with their timers. */
	readonly limit?: number | undefined;
}

export interface ToastStore {
	/** The current queue, oldest first. Stable between changes. */
	list(): readonly Toast[];
	subscribe(listener: () => void): () => void;
	push(tone: ToastTone, message: string, durationMs?: number): string;
	success(message: string, durationMs?: number): string;
	error(message: string, durationMs?: number): string;
	info(message: string, durationMs?: number): string;
	dismiss(id: string): void;
	clear(): void;
}

const DEFAULT_DURATION_MS = 5000;
const DEFAULT_LIMIT = 4;

/**
 * A bounded toast queue. The queue owns one timer per live toast and clears it
 * on removal, so nothing is scheduled for a toast that is already gone and the
 * queue never grows past `limit`.
 */
export function createToastStore(options: ToastStoreOptions = {}): ToastStore {
	const defaultDuration = options.durationMs ?? DEFAULT_DURATION_MS;
	const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const listeners = new Set<() => void>();
	let snapshot: readonly Toast[] = [];
	let sequence = 0;

	const notify = () => {
		for (const listener of listeners) {
			/* A host that throws must not take the queue, its timers, or the other
			   hosts down with it. */
			try {
				listener();
			} catch {
				/* the listener owns its own failure */
			}
		}
	};

	const stopTimer = (id: string) => {
		const timer = timers.get(id);
		if (timer === undefined) return;
		clearTimeout(timer);
		timers.delete(id);
	};

	const dismiss = (id: string) => {
		const next = snapshot.filter((toast) => toast.id !== id);
		stopTimer(id);
		if (next.length === snapshot.length) return;
		snapshot = next;
		notify();
	};

	const push = (
		tone: ToastTone,
		message: string,
		durationMs: number = defaultDuration,
	): string => {
		sequence += 1;
		const id = `toast-${sequence}`;
		const overflow = snapshot.length + 1 - limit;
		if (overflow > 0)
			for (let index = 0; index < overflow; index += 1)
				stopTimer(snapshot[index]!.id);
		snapshot = [
			...(overflow > 0 ? snapshot.slice(overflow) : snapshot),
			{ id, tone, message },
		];
		if (durationMs > 0)
			timers.set(
				id,
				setTimeout(() => dismiss(id), durationMs),
			);
		notify();
		return id;
	};

	return {
		list: () => snapshot,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		push,
		success: (message, durationMs) => push('success', message, durationMs),
		error: (message, durationMs) => push('error', message, durationMs),
		info: (message, durationMs) => push('info', message, durationMs),
		dismiss,
		clear: () => {
			for (const toast of snapshot) stopTimer(toast.id);
			if (snapshot.length === 0) return;
			snapshot = [];
			notify();
		},
	};
}

/** The queue every `ToastHost` reads unless it is given one of its own. */
export const toasts: ToastStore = createToastStore();
