import type {
	ConnectorCalls,
	ConnectorDefinitionShape,
	ConnectorInstances,
	ConnectorModuleCredentials,
	ConnectorModuleInstance,
} from '../../src/services/capabilities.ts';

type CallRequest = Parameters<ConnectorCalls['call']>[0];
type CallResult = Awaited<ReturnType<ConnectorCalls['call']>>;

export interface StubConnectors {
	readonly instances: ConnectorInstances;
	readonly calls: ConnectorCalls;
	readonly definitions: {
		register(definition: ConnectorDefinitionShape): void;
		get(key: string): ConnectorDefinitionShape | null;
	};
	/** Every call as connectors.core received it. */
	readonly requests: CallRequest[];
	/** What connectors.core would seal, by tenant and module key; never answered. */
	readonly sealed: Map<string, ConnectorModuleCredentials>;
	readonly upserts: Parameters<ConnectorInstances['upsertModuleInstance']>[0][];
	answer(handler: (request: CallRequest) => Partial<CallResult>): void;
}

export function succeeded(body: unknown): Partial<CallResult> {
	return { outcome: 'succeeded', status: 200, errorClass: null, body };
}

export function failed(
	status: number,
	retryAfterMs: number | null = null,
): Partial<CallResult> {
	return {
		outcome: 'failed',
		status,
		errorClass: status >= 500 ? 'response-5xx' : 'response-4xx',
		body: null,
		retryAfterMs,
	};
}

/**
 * connectors.core as research sees it: module instances keyed per tenant and
 * module key, the credential held back from every answer, calls answered by
 * the case's handler.
 */
export function stubConnectors(): StubConnectors {
	const stored = new Map<string, ConnectorModuleInstance>();
	const sealed = new Map<string, ConnectorModuleCredentials>();
	const registered = new Map<string, ConnectorDefinitionShape>();
	const requests: CallRequest[] = [];
	const upserts: StubConnectors['upserts'] = [];
	let handler: (request: CallRequest) => Partial<CallResult> = () =>
		succeeded({});
	const slot = (tenantId: string, moduleId: string, key: string) =>
		`${tenantId}/${moduleId}/${key}`;
	return {
		requests,
		sealed,
		upserts,
		answer(next) {
			handler = next;
		},
		definitions: {
			register: (definition) => registered.set(definition.key, definition),
			get: (key) => registered.get(key) ?? null,
		},
		instances: {
			async upsertModuleInstance(input) {
				upserts.push(input);
				const id = slot(input.tenantId, input.moduleId, input.key);
				const existing = stored.get(id);
				if (input.credentials !== undefined) sealed.set(id, input.credentials);
				const credential = sealed.get(id);
				const instance: ConnectorModuleInstance = {
					id: `instance-${input.key}-${input.tenantId}`,
					moduleId: input.moduleId,
					key: input.key,
					definition: input.definition,
					name: input.key,
					baseUrl: new URL(input.baseUrl).href,
					authKind: credential?.kind ?? existing?.authKind ?? 'none',
					hasCredentials:
						credential !== undefined && credential.kind !== 'none',
					allowedHosts: input.allowedHosts,
					allowAgents: input.allowAgents,
					allowWorkflows: input.allowWorkflows,
					status: existing?.status ?? 'active',
					updatedAt: 1,
				};
				stored.set(id, instance);
				return instance;
			},
			async describeModuleInstance(input) {
				return (
					stored.get(slot(input.tenantId, input.moduleId, input.key)) ?? null
				);
			},
		},
		calls: {
			async call(request) {
				requests.push(request);
				return {
					callId: `call-${requests.length}`,
					outcome: 'succeeded',
					status: 200,
					errorClass: null,
					body: null,
					retryAfterMs: null,
					...handler(request),
				};
			},
		},
	};
}
