import { t } from '@coreloom/client/i18n';
import type { VariableDefinition } from '@coreloom/contracts';
import type {
	AutomationAgent,
	AutomationSchedule,
	AutomationTargetOption,
	AutomationTrigger,
	AutomationTriggerSecret,
	CreateAutomationScheduleInput,
	CreateAutomationTriggerInput,
	UpdateAutomationScheduleInput,
} from '../domain/types.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(
			value.error?.message ?? t('automations.common.requestFailed'),
		);
	}
	return value;
}

function mutation(path: string, body: unknown, csrfToken: string) {
	return fetch(path, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(body),
	});
}

export async function loadAutomationSchedules(): Promise<{
	readonly schedules: readonly AutomationSchedule[];
	readonly agents: readonly AutomationAgent[];
	readonly targets: readonly AutomationTargetOption[];
	readonly variables: readonly VariableDefinition[];
}> {
	return payload(
		await fetch('/api/automations/schedules', {
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		}),
	);
}

export async function createAutomationSchedule(
	input: CreateAutomationScheduleInput,
	csrfToken: string,
): Promise<AutomationSchedule> {
	return (
		await payload<{ readonly schedule: AutomationSchedule }>(
			await mutation('/api/automations/schedules', input, csrfToken),
		)
	).schedule;
}

export async function updateAutomationSchedule(
	input: UpdateAutomationScheduleInput,
	csrfToken: string,
): Promise<AutomationSchedule> {
	return (
		await payload<{ readonly schedule: AutomationSchedule }>(
			await mutation('/api/automations/schedules/update', input, csrfToken),
		)
	).schedule;
}

export async function deleteAutomationSchedule(
	id: string,
	csrfToken: string,
): Promise<void> {
	await payload(
		await mutation('/api/automations/schedules/delete', { id }, csrfToken),
	);
}

export async function runAutomationSchedule(
	id: string,
	csrfToken: string,
): Promise<{ readonly id: string }> {
	return (
		await payload<{ readonly run: { readonly id: string } }>(
			await mutation('/api/automations/schedules/run', { id }, csrfToken),
		)
	).run;
}

export async function loadAutomationTriggers(): Promise<{
	readonly triggers: readonly AutomationTrigger[];
	readonly agents: readonly AutomationAgent[];
	readonly targets: readonly AutomationTargetOption[];
}> {
	return payload(
		await fetch('/api/automations/triggers', {
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		}),
	);
}

export async function createAutomationTrigger(
	input: CreateAutomationTriggerInput,
	csrfToken: string,
): Promise<AutomationTriggerSecret> {
	return payload(await mutation('/api/automations/triggers', input, csrfToken));
}

export async function updateAutomationTrigger(
	id: string,
	input: CreateAutomationTriggerInput,
	csrfToken: string,
): Promise<AutomationTrigger> {
	return (
		await payload<{ readonly trigger: AutomationTrigger }>(
			await mutation(
				'/api/automations/triggers/update',
				{ id, ...input },
				csrfToken,
			),
		)
	).trigger;
}

export async function rotateAutomationTrigger(
	id: string,
	csrfToken: string,
): Promise<AutomationTriggerSecret> {
	return payload(
		await mutation('/api/automations/triggers/rotate', { id }, csrfToken),
	);
}

export async function deleteAutomationTrigger(
	id: string,
	csrfToken: string,
): Promise<void> {
	await payload(
		await mutation('/api/automations/triggers/delete', { id }, csrfToken),
	);
}
