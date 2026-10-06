import type {
	CliExtensionContext,
	CliExtensionResult,
} from '@flowdular/cli-protocol';
import type { AuthService } from '../services/auth-service.ts';
import type { TenantSummary } from '../services/repository.ts';
import { operatorOf, withAuth } from './provisioning.ts';

const SPEC_EVIDENCE = 'modules/auth/spec/module.yaml';
const OVERRIDE_VARIABLE = 'FD_OPERATOR_TENANT';
const SET_COMMAND = 'pnpm flowdular auth operator-set <id|slug> --apply';

type OverrideReport =
	| { readonly variable: string; readonly set: false }
	| {
			readonly variable: string;
			readonly set: true;
			readonly value: string;
			/* Only a workspace id counts: system.core never resolves a slug here. */
			readonly workspace: TenantSummary | null;
	  };

/* The variable is read from this shell only to tell the operator that, where
   the deployment sets it, it decides instead of the record. auth.core's answer
   to system.core never reads it. */
async function overrideReport(service: AuthService): Promise<OverrideReport> {
	const value = process.env[OVERRIDE_VARIABLE]?.trim();
	if (!value) return { variable: OVERRIDE_VARIABLE, set: false };
	const found = await service.findTenant(value);
	return {
		variable: OVERRIDE_VARIABLE,
		set: true,
		value,
		workspace: found?.tenantId === value ? found : null,
	};
}

function overrideWarnings(override: OverrideReport): readonly string[] {
	if (!override.set) return [];
	return override.workspace
		? [
				`${OVERRIDE_VARIABLE} is set in this shell and names "${override.workspace.slug}". Wherever the deployment sets it, it overrides this record.`,
			]
		: [
				`${OVERRIDE_VARIABLE} is set in this shell but names no workspace id. Wherever the deployment sets it so, no workspace is the operator, whatever this record says.`,
			];
}

export async function readOperator(
	context: CliExtensionContext,
): Promise<CliExtensionResult> {
	return withAuth(context, async (auth) => {
		const service = await auth.service();
		const operator = await service.operatorWorkspace();
		const override = await overrideReport(service);
		return {
			data: { operator, override },
			evidence: [SPEC_EVIDENCE],
			warnings: [
				...(operator
					? []
					: [
							`No workspace is recorded as this deployment's operator, so where ${OVERRIDE_VARIABLE} is unset no workspace changes platform-scoped settings. Record one with ${SET_COMMAND}.`,
						]),
				...overrideWarnings(override),
			],
		};
	});
}

export async function setOperator(
	context: CliExtensionContext,
): Promise<CliExtensionResult> {
	const reference = context.arguments[0]?.trim();
	if (!reference) {
		throw new Error(`Name the workspace: ${SET_COMMAND}.`);
	}
	const operator = operatorOf(context);
	return withAuth(context, async (auth) => {
		const service = await auth.service();
		const plan = context.apply
			? await service.setOperator(reference, operator)
			: await service.planOperatorChange(reference, operator);
		const override = await overrideReport(service);
		return {
			data: { applied: context.apply, ...plan, override },
			evidence: [SPEC_EVIDENCE],
			warnings: [
				...(plan.changed
					? []
					: [
							`"${plan.to.slug}" is already the operator workspace. Nothing was changed.`,
						]),
				...overrideWarnings(override),
			],
		};
	});
}
