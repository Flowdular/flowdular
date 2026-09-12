import {
	REPORT_PROVIDER_LIMITS,
	type ReportProvider,
	type ReportProviderRegistry,
} from '../domain/providers.ts';
import { ReportsServiceError } from './service-error.ts';

const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const PROVIDER_KEY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const PERMISSION_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export interface RegisteredReportProvider extends ReportProvider {
	readonly moduleId: string;
}

export interface MutableReportProviderRegistry extends ReportProviderRegistry {
	/** Closes registration. Every later call answers `PROVIDER_REGISTRY_SEALED`. */
	seal(): void;
	/** Registration order, which is the order the screen renders in. */
	list(): readonly RegisteredReportProvider[];
}

function refuse(code: string, message: string): never {
	throw new ReportsServiceError(code, message, 500);
}

function text(
	value: unknown,
	field: string,
	maximum: number,
	pattern?: RegExp,
): string {
	if (typeof value !== 'string' || value.length === 0) {
		refuse('PROVIDER_INVALID', `A report provider ${field} must be text.`);
	}
	if (value.length > maximum) {
		refuse(
			'PROVIDER_INVALID',
			`A report provider ${field} is at most ${maximum} characters.`,
		);
	}
	if (pattern && !pattern.test(value)) {
		refuse(
			'PROVIDER_INVALID',
			`Report provider ${field} "${value}" is not valid.`,
		);
	}
	return value;
}

/**
 * The providers of one process. Registration happens while modules compose and
 * closes before the first request, so every request reads the same list in the
 * same order and a lookup is an array walk over at most
 * `REPORT_PROVIDER_LIMITS.providers` entries.
 */
export function createReportProviderRegistry(): MutableReportProviderRegistry {
	const providers: RegisteredReportProvider[] = [];
	const keys = new Set<string>();
	let sealed: readonly RegisteredReportProvider[] | null = null;

	return {
		register(moduleId, entries) {
			if (sealed) {
				refuse(
					'PROVIDER_REGISTRY_SEALED',
					`${String(moduleId)} registers a report provider after reports.core started.`,
				);
			}
			text(moduleId, 'module id', REPORT_PROVIDER_LIMITS.moduleId, MODULE_ID);
			if (!Array.isArray(entries)) {
				refuse(
					'PROVIDER_INVALID',
					`${moduleId} must register a list of report providers.`,
				);
			}
			if (
				providers.length + entries.length >
				REPORT_PROVIDER_LIMITS.providers
			) {
				refuse(
					'PROVIDER_LIMIT_EXCEEDED',
					`A deployment registers at most ${REPORT_PROVIDER_LIMITS.providers} report providers.`,
				);
			}
			/* Validated in full before anything is kept, so a bad entry in the
			   middle of a module's list cannot leave half of it registered. */
			const accepted: RegisteredReportProvider[] = [];
			const pending = new Set<string>();
			for (const provider of entries) {
				const key = text(
					provider?.key,
					'key',
					REPORT_PROVIDER_LIMITS.key,
					PROVIDER_KEY,
				);
				if (keys.has(key) || pending.has(key)) {
					refuse(
						'PROVIDER_DUPLICATE',
						`Report provider "${key}" is already registered.`,
					);
				}
				pending.add(key);
				accepted.push({
					key,
					moduleId,
					label: text(provider.label, 'label', REPORT_PROVIDER_LIMITS.label),
					...(provider.labelKey === undefined
						? {}
						: {
								labelKey: text(
									provider.labelKey,
									'label key',
									REPORT_PROVIDER_LIMITS.key,
								),
							}),
					permission: text(
						provider.permission,
						'permission',
						REPORT_PROVIDER_LIMITS.permission,
						PERMISSION_ID,
					),
					read:
						typeof provider.read === 'function'
							? provider.read.bind(provider)
							: refuse(
									'PROVIDER_INVALID',
									`Report provider "${key}" has no read operation.`,
								),
				});
			}
			for (const provider of accepted) {
				keys.add(provider.key);
				providers.push(provider);
			}
		},
		seal() {
			sealed ??= [...providers];
		},
		list() {
			return sealed ?? providers;
		},
	};
}
