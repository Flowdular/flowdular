import { describe, expect, it } from 'vitest';
import {
	CONNECTOR_CALLER_KINDS,
	connectorFormState,
	consentChange,
	consentGranted,
} from '../src/client/consent.ts';
import type { ConnectorInstance } from '../src/domain/types.ts';

function instance(
	allowWorkflows: boolean,
	allowAgents: boolean,
): ConnectorInstance {
	return {
		id: 'instance-1',
		tenantId: 'tenant-a',
		definitionKey: 'http-json',
		name: 'Billing',
		baseUrl: 'https://api.example.test/v1',
		authKind: 'none',
		credentialFingerprint: null,
		allowedHosts: ['api.example.test'],
		allowWorkflows,
		allowAgents,
		status: 'active',
		lastCallAt: null,
		createdAt: 1,
		updatedAt: 1,
	};
}

describe('connector consent changes', () => {
	/* The screen used to send one value for both flags, so turning workflows off
	   at (true, false) turned agents on. */
	it('moves only the caller kind the owner confirmed', () => {
		expect(consentChange(instance(true, false), 'workflows', false)).toEqual({
			allowWorkflows: false,
			allowAgents: false,
		});
		expect(consentChange(instance(true, false), 'agents', true)).toEqual({
			allowWorkflows: true,
			allowAgents: true,
		});
		expect(consentChange(instance(false, true), 'workflows', true)).toEqual({
			allowWorkflows: true,
			allowAgents: true,
		});
		expect(consentChange(instance(true, true), 'agents', false)).toEqual({
			allowWorkflows: true,
			allowAgents: false,
		});
	});

	it('never raises the kind it was not asked about, in any starting state', () => {
		for (const workflows of [false, true]) {
			for (const agents of [false, true]) {
				const current = instance(workflows, agents);
				for (const kind of CONNECTOR_CALLER_KINDS) {
					for (const next of [false, true]) {
						const changed = consentChange(current, kind, next);
						const other = kind === 'workflows' ? 'agents' : 'workflows';
						expect([kind, next, consentGranted(changed, other)]).toEqual([
							kind,
							next,
							consentGranted(current, other),
						]);
						expect(consentGranted(changed, kind)).toBe(next);
					}
				}
			}
		}
	});

	it('reads each flag under its own caller kind', () => {
		expect(consentGranted(instance(true, false), 'workflows')).toBe(true);
		expect(consentGranted(instance(true, false), 'agents')).toBe(false);
	});
});

describe('connector drawer state', () => {
	it('renders the form for a new instance and for one that is loaded', () => {
		expect(
			connectorFormState({ status: 'idle', selectedId: '', instance: null }),
		).toBe('ready');
		expect(
			connectorFormState({
				status: 'idle',
				selectedId: 'instance-1',
				instance: instance(false, false),
			}),
		).toBe('ready');
	});

	it('waits while the list is still loading instead of reporting a gap', () => {
		expect(
			connectorFormState({
				status: 'loading',
				selectedId: 'instance-1',
				instance: null,
			}),
		).toBe('loading');
	});

	it('says the instance is gone once the load finished without it', () => {
		expect(
			connectorFormState({
				status: 'idle',
				selectedId: 'instance-1',
				instance: null,
			}),
		).toBe('missing');
		expect(
			connectorFormState({
				status: 'error',
				selectedId: 'instance-1',
				instance: null,
			}),
		).toBe('missing');
	});

	it('reports a denial ahead of everything else', () => {
		expect(
			connectorFormState({
				status: 'denied',
				selectedId: 'instance-1',
				instance: instance(false, false),
			}),
		).toBe('denied');
		expect(
			connectorFormState({ status: 'denied', selectedId: '', instance: null }),
		).toBe('denied');
	});
});
