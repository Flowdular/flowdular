import type { VariableSource } from '@coreloom/contracts';
import type { AgentTool, AgentToolContext } from '@coreloom/harness/runtime';
import {
	VariableResolutionError,
	type PlatformVariableRegistry,
	type VariableSourceResolutionContext,
} from '@coreloom/kernel';
import { PARTY_PERMISSIONS } from '../acl/permissions.ts';
import type { Party } from './types.ts';

export const PARTY_VARIABLE_SOURCE: VariableSource = {
	id: 'parties.records',
	variables: [
		{
			key: 'party.name',
			label: 'Party name',
			kind: 'text',
			scope: PARTY_PERMISSIONS.read,
		},
		{
			key: 'party.email',
			label: 'Party email',
			kind: 'identifier',
			scope: PARTY_PERMISSIONS.read,
		},
		{
			key: 'party.vatId',
			label: 'Party VAT ID',
			kind: 'identifier',
			scope: PARTY_PERMISSIONS.read,
		},
	],
};

function toolContext(
	context: VariableSourceResolutionContext,
): AgentToolContext {
	return {
		runId:
			context.actor.kind === 'agent'
				? context.actor.runId!
				: `variable:${context.actor.kind}:${context.actor.id}`,
		tenantId: context.tenantId,
		requestedBy: context.actor.id,
		permissions: new Set(context.permissionSnapshot),
		signal: context.signal,
	};
}

/* This adapter deliberately invokes the public read tool. The shared registry
   validates scope and the explicit partyId binding before this callback runs;
   the tool takes the tenant from its trusted context and returns null for a
   record owned by another tenant. */
export function registerPartyVariableSource(
	registry: PlatformVariableRegistry,
	tools: readonly AgentTool[],
): void {
	const read = tools.find((tool) => tool.id === 'parties.customer.get');
	if (!read || !read.requiredPermissions.includes(PARTY_PERMISSIONS.read)) {
		throw new Error(
			'parties.customer.get must require parties.records.read before variables can be registered.',
		);
	}
	const requiredBindings = Object.fromEntries(
		PARTY_VARIABLE_SOURCE.variables.map((variable) => [
			variable.key,
			['partyId'] as const,
		]),
	);
	registry.register(PARTY_VARIABLE_SOURCE, {
		requiredBindings,
		resolve: async (context) => {
			if (
				!read.requiredPermissions.every((permission) =>
					context.permissionSnapshot.includes(permission),
				)
			) {
				throw new VariableResolutionError(
					'FORBIDDEN_TEMPLATE_VARIABLE',
					'The variable source is unavailable to this actor.',
				);
			}
			const party = (await read.execute(
				{ id: context.bindings.partyId },
				toolContext(context),
			)) as Party | null;
			if (!party) {
				throw new VariableResolutionError(
					'VARIABLE_VALUE_UNAVAILABLE',
					'A variable value is unavailable.',
				);
			}
			return {
				'party.name': party.name,
				'party.email': party.email ?? '',
				'party.vatId': party.vatId ?? '',
			};
		},
	});
}
