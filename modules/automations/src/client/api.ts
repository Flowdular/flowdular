import { t } from '@flowdular/client/i18n';
import type { VariableDefinition } from '@flowdular/contracts';
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

export type AutomationListSortKey = 'label' | 'updatedAt';

export interface AutomationListRequest {
	readonly sort: AutomationListSortKey;
	readonly direction: 'asc' | 'desc';
	readonly enabledOnly: boolean;
	readonly query: string;
	readonly limit: number;
	/** The opaque cursor that opens this page; null for the first one. */
	readonly cursor: string | null;
}

export interface AutomationListPage<Item> {
	readonly items: readonly Item[];
	readonly page: {
		readonly nextCursor: string | null;
		readonly limit: number;
	};
}

function listUrl(path: string, request: AutomationListRequest): string {
	const search = new URLSearchParams({
		sort: request.sort,
		direction: request.direction,
		limit: String(request.limit),
	});
	if (request.enabledOnly) search.set('enabled', 'true');
	if (request.query.trim() !== '') search.set('q', request.query.trim());
	if (request.cursor) search.set('cursor', request.cursor);
	return path + '?' + search.toString();
}

function read<T>(url: string): Promise<T> {
	return fetch(url, {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	}).then((response) => payload<T>(response));
}

/** What the schedule and trigger forms offer: read once, not per page. */
export async function loadAutomationOptions(): Promise<{
	readonly agents: readonly AutomationAgent[];
	readonly targets: readonly AutomationTargetOption[];
	readonly variables: readonly VariableDefinition[];
	/** Workspace zone the cron slots and the listed times are read in. */
	readonly timeZone: string;
}> {
	return read('/api/automations/options');
}

/** The trigger form's targets, under the trigger read permission alone. */
export async function loadAutomationTriggerOptions(): Promise<{
	readonly agents: readonly AutomationAgent[];
	readonly targets: readonly AutomationTargetOption[];
}> {
	return read('/api/automations/triggers/options');
}

export async function loadAutomationSchedules(
	request: AutomationListRequest,
): Promise<AutomationListPage<AutomationSchedule>> {
	return read(listUrl('/api/automations/schedules', request));
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

export async function loadAutomationTriggers(
	request: AutomationListRequest,
): Promise<AutomationListPage<AutomationTrigger>> {
	return read(listUrl('/api/automations/triggers', request));
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
