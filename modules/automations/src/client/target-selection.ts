import type { AutomationTargetOption } from '../domain/types.ts';

export function automationTargetValue(
	target: Pick<AutomationTargetOption, 'kind' | 'key'>,
): string {
	return `${encodeURIComponent(target.kind)}:${encodeURIComponent(target.key)}`;
}

export function parseAutomationTargetValue(value: string): {
	readonly kind: string;
	readonly key: string;
} {
	const separator = value.indexOf(':');
	if (separator <= 0 || separator === value.length - 1) {
		return { kind: '', key: '' };
	}
	try {
		return {
			kind: decodeURIComponent(value.slice(0, separator)),
			key: decodeURIComponent(value.slice(separator + 1)),
		};
	} catch {
		return { kind: '', key: '' };
	}
}

export function automationTargetOptions(
	targets: readonly AutomationTargetOption[],
	current: Pick<AutomationTargetOption, 'kind' | 'key' | 'label'> | null,
): readonly (AutomationTargetOption & { readonly value: string })[] {
	const options = [...targets];
	if (
		current &&
		!options.some(
			(target) => target.kind === current.kind && target.key === current.key,
		)
	) {
		options.push({ ...current, available: false });
	}
	return options.map((target) => ({
		...target,
		value: automationTargetValue(target),
	}));
}
