import type {
	ConnectorCalls,
	ConnectorInstances,
	ConnectorModuleInstance,
} from '../services/capabilities.ts';
import { ResearchServiceError } from '../services/service-error.ts';
import { RESEARCH_MODULE_ID } from '../domain/types.ts';
import type { ResearchCaller } from '../domain/capability.ts';

type CallResult = Awaited<ReturnType<ConnectorCalls['call']>>;

/* Refused by the owner's own switches, not by the provider. */
const OWNER_REFUSALS = new Set(['consent-missing', 'instance-disabled']);

const RETRYABLE_CLASSES = new Set([
	'timeout',
	'dns',
	'network',
	'response-5xx',
]);

/**
 * One classification for every connector-backed adapter. The answer never
 * carries the body: a provider's error text may echo a credential back.
 */
export function connectorCallFailure(
	result: CallResult,
	label: string,
): ResearchServiceError {
	const status = result.status;
	const errorClass = result.errorClass ?? 'unknown';
	if (errorClass === 'timeout') {
		return new ResearchServiceError(
			'RESEARCH_ADAPTER_TIMEOUT',
			`${label} did not answer in time.`,
			504,
			{ retryable: true },
		);
	}
	if (status === 429) {
		return new ResearchServiceError(
			'RESEARCH_ADAPTER_RATE_LIMITED',
			`${label} asked to slow down.`,
			429,
			{ retryable: true, retryAfterMs: result.retryAfterMs ?? null },
		);
	}
	if (status === 401 || status === 403) {
		return new ResearchServiceError(
			'RESEARCH_ADAPTER_UNAUTHORIZED',
			`${label} refused the credential with ${status}.`,
			502,
		);
	}
	return new ResearchServiceError(
		'RESEARCH_CONNECTOR_FAILED',
		`The ${label} call ${result.outcome}: ${errorClass}${status === null ? '' : ` (${status})`}.`,
		502,
		{
			retryable: RETRYABLE_CLASSES.has(errorClass) || status === 408,
			retryAfterMs: result.retryAfterMs ?? null,
			health: !OWNER_REFUSALS.has(errorClass),
		},
	);
}

export function notConfigured(label: string): ResearchServiceError {
	return new ResearchServiceError(
		'RESEARCH_ADAPTER_UNAVAILABLE',
		`${label} is not configured for this workspace.`,
		409,
	);
}

export function connectorCaller(
	caller: ResearchCaller,
): 'test' | 'workflow' | 'agent' {
	return caller === 'member' ? 'test' : caller;
}

/**
 * The module-owned instance an adapter calls, or the not configured refusal.
 * An agent or workflow call needs allowAgents here as well, so an instance
 * whose consent did not follow a change of the setting is never used for one.
 */
export async function moduleInstance(
	instances: () => ConnectorInstances | undefined,
	calls: () => ConnectorCalls | undefined,
	request: {
		readonly tenantId: string;
		readonly caller: ResearchCaller;
		readonly allowAgents: boolean;
	},
	key: string,
	label: string,
): Promise<{ instance: ConnectorModuleInstance; calls: ConnectorCalls }> {
	if (request.caller !== 'member' && !request.allowAgents) {
		throw new ResearchServiceError(
			'TOOL_NOT_CONSENTED',
			`The workspace does not let agents or workflows use ${label}.`,
			403,
		);
	}
	const tenantId = request.tenantId;
	const registry = instances();
	const capability = calls();
	if (!registry || !capability) throw notConfigured(label);
	const instance = await registry.describeModuleInstance({
		tenantId,
		moduleId: RESEARCH_MODULE_ID,
		key,
	});
	if (!instance || instance.status !== 'active') throw notConfigured(label);
	return { instance, calls: capability };
}
