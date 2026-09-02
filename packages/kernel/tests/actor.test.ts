import { describe, expect, it } from 'vitest';
import {
	agentActor,
	actorsEqual,
	normalizeActor,
	serviceActor,
	userActor,
} from '../src/actor.ts';

describe('audit actors', () => {
	it('normalizes users through the same typed contract', () => {
		expect(
			userActor({
				accountId: ' account-1 ',
				displayName: ' Ada Lovelace ',
				email: 'ada@example.test',
			}),
		).toEqual({ kind: 'user', id: 'account-1', label: 'Ada Lovelace' });
	});

	it('uses the email when a user has no display name', () => {
		expect(
			userActor({
				accountId: 'account-1',
				displayName: ' ',
				email: 'ada@example.test',
			}),
		).toEqual({ kind: 'user', id: 'account-1', label: 'ada@example.test' });
	});

	it('keeps every agent traceable to its run', () => {
		expect(
			agentActor({
				runId: 'run-1',
				agentId: 'agent-1',
				agentName: 'Catalog curator',
			}),
		).toEqual({
			kind: 'agent',
			id: 'agent-1',
			label: 'Catalog curator',
			runId: 'run-1',
		});
	});

	it('keeps a service traceable to the user who configured it', () => {
		expect(
			serviceActor({
				serviceId: 'workflow-schedule-1',
				label: 'Daily invoice workflow',
				configuredBy: {
					accountId: 'account-1',
					displayName: 'Ada Lovelace',
					email: 'ada@example.test',
				},
			}),
		).toEqual({
			kind: 'service',
			id: 'workflow-schedule-1',
			label: 'Daily invoice workflow',
			configuredBy: {
				kind: 'user',
				id: 'account-1',
				label: 'Ada Lovelace',
			},
		});
	});

	it('refuses an invalid or untraceable actor', () => {
		expect(
			normalizeActor({
				kind: 'agent',
				id: 'agent-1',
				label: 'Catalog curator',
				runId: '',
			}),
		).toBeNull();
		expect(
			normalizeActor({ kind: 'user', id: '', label: 'Unknown' }),
		).toBeNull();
		expect(
			normalizeActor({
				kind: 'service',
				id: 'schedule-1',
				label: 'Schedule',
				configuredBy: {
					kind: 'user',
					id: '',
					label: 'Unknown',
				},
			}),
		).toBeNull();
	});

	it('compares durable actor identity without treating labels as authority', () => {
		expect(
			actorsEqual(
				{ kind: 'user', id: 'account-1', label: 'Ada' },
				{ kind: 'user', id: 'account-1', label: 'Ada Lovelace' },
			),
		).toBe(true);
		expect(
			actorsEqual(
				{
					kind: 'service',
					id: 'schedule-1',
					label: 'Daily run',
					configuredBy: { kind: 'user', id: 'account-1', label: 'Ada' },
				},
				{
					kind: 'service',
					id: 'schedule-1',
					label: 'Daily run',
					configuredBy: { kind: 'user', id: 'account-2', label: 'Grace' },
				},
			),
		).toBe(false);
		expect(
			actorsEqual(
				{ kind: 'agent', id: 'agent-1', label: 'Agent', runId: 'run-1' },
				{ kind: 'agent', id: 'agent-1', label: 'Agent', runId: 'run-2' },
			),
		).toBe(false);
	});
});
