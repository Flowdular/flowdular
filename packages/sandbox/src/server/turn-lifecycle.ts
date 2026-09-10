import { realpathSync } from 'node:fs';
import { SandboxSetupError } from './workspace-root.ts';

export type TurnSubscriber = (event: string, payload: unknown) => void;

export interface TurnChannel {
	readonly controller: AbortController;
	readonly finished: Promise<void>;
	readonly subscribers: Set<TurnSubscriber>;
}

const SLOT = Symbol.for('flowdular.sandbox.turn-channels');
type Channels = Map<string, Map<string, TurnChannel>>;

/** Route HMR replaces closures, not the detached writers those closures own. */
export function processTurnChannels(
	workspaceRoot: string,
): Map<string, TurnChannel> {
	const state = globalThis as unknown as Record<symbol, Channels | undefined>;
	const workspaces = (state[SLOT] ??= new Map());
	const root = realpathSync(workspaceRoot);
	let channels = workspaces.get(root);
	if (!channels) {
		channels = new Map();
		workspaces.set(root, channels);
	}
	return channels;
}

/** A deadline refuses the operation; it never releases the live writer. */
export async function waitForTurn(
	channel: TurnChannel,
	timeoutMs = 20_000,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			channel.finished,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new SandboxSetupError(
								'SESSION_RUNNING',
								'The previous turn is still stopping. Wait for it to finish before changing this session.',
							),
						),
					timeoutMs,
				);
				timer.unref?.();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
