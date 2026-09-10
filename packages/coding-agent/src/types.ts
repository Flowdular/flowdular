import type { AiUsage } from '@flowdular/ai-provider';

/* A sandbox that cannot prove it is loopback treats itself as self-hosted and
   never offers a driver that shells out to a local binary. */
export type SandboxRuntimeMode = 'loopback' | 'self-hosted';

export type CodingAgentDriverKind = 'local-cli' | 'byok';

export type FileChangeKind = 'created' | 'modified' | 'deleted';

export type CodingAgentEvent =
	| {
			readonly type: 'turn.started';
			readonly driver: string;
			readonly role: string;
			readonly resumeId: string | null;
	  }
	| { readonly type: 'assistant.message'; readonly text: string }
	| { readonly type: 'reasoning'; readonly text: string }
	| { readonly type: 'activity'; readonly phase: 'thinking' | 'responding' }
	| {
			readonly type: 'tool.started';
			readonly callId?: string;
			readonly tool: string;
			readonly detail: string;
	  }
	| {
			readonly type: 'tool.completed';
			readonly callId?: string;
			readonly tool: string;
			readonly detail: string;
			readonly ok: boolean;
	  }
	| {
			readonly type: 'file.changed';
			readonly path: string;
			readonly change: FileChangeKind;
	  }
	| {
			readonly type: 'error';
			readonly code: string;
			readonly message: string;
	  }
	| {
			readonly type: 'turn.completed';
			readonly resumeId: string | null;
			readonly usage: AiUsage;
			readonly costUsd: number | null;
			readonly finishReason: 'stop' | 'error' | 'aborted';
	  };

export interface CodingAgentMessage {
	readonly role: 'user' | 'assistant';
	readonly text: string;
}

export interface CodingAgentTurnRequest {
	/* The only directory the driver may read from or write to. */
	readonly workspacePath: string;
	/* Writes are narrower than reads. The orchestrator expands the active
	   role's globs to the one draft module owned by this turn. */
	readonly allowedPaths?: readonly string[] | undefined;
	readonly role: string;
	readonly systemInstruction: string;
	readonly prompt: string;
	/* Provider-side conversation identifier returned by an earlier turn. */
	readonly resumeId?: string | null;
	/* Prior turns of this session. Drivers backed by a stateful CLI ignore it
	   and resume by identifier; the BYOK driver replays it. */
	readonly history?: readonly CodingAgentMessage[] | undefined;
	readonly model?: string | null;
	readonly signal?: AbortSignal | undefined;
	readonly timeoutMs?: number | undefined;
}

export interface CodingAgentAvailability {
	readonly available: boolean;
	readonly detail: string;
	readonly version: string | null;
}

export interface CodingAgentDriverInfo {
	readonly id: string;
	readonly label: string;
	readonly kind: CodingAgentDriverKind;
	/* Local binaries carry the operator's own login and file system reach, so
	   they are offered only by a loopback sandbox. */
	readonly requiresLoopback: boolean;
	readonly description: string;
}

export interface CodingAgentDriver extends CodingAgentDriverInfo {
	probe(): Promise<CodingAgentAvailability>;
	run(request: CodingAgentTurnRequest): AsyncIterable<CodingAgentEvent>;
}

export class CodingAgentError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'CodingAgentError';
	}
}
