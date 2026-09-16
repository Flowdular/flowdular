import { join } from 'node:path';
import type { ModuleSettingValue } from '@flowdular/kernel';
import { parse as parseYaml } from 'yaml';
import { readSpecText } from './spec.ts';
import { SandboxSetupError } from './workspace-root.ts';

export const RESEARCH_MODULE_ID = 'research.core';
export const RESEARCH_FIXTURES_FILE = 'research-fixtures.json';
export const LIVE_ADAPTER_REFUSED = 'SANDBOX_LIVE_ADAPTER_REFUSED';
const LIVE_RESEARCH_ADAPTERS = new Set([
	'model-native',
	'searxng',
	'firecrawl',
	'connector',
]);

export interface DraftModuleLocation {
	readonly directory: string;
	readonly path: string;
}

export interface LiveAdapterDeclaration {
	readonly module: string;
	readonly field: string;
	readonly value: string;
}

export interface SessionAdapters {
	/* The first draft whose spec has a research section; the preview answers
	   research from that module's recorded fixtures. */
	readonly research: {
		readonly module: string;
		readonly fixturesPath: string;
	} | null;
	readonly live: readonly LiveAdapterDeclaration[];
}

function objectOf(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/* Reads the research and adapters sections as plain YAML. The spec-schema gate
   stays the authority on their shape, so a spec this cannot read declares
   nothing here. */
export async function readSessionAdapters(
	modules: readonly DraftModuleLocation[],
): Promise<SessionAdapters> {
	let research: SessionAdapters['research'] = null;
	const live: LiveAdapterDeclaration[] = [];
	for (const module of modules) {
		const text = await readSpecText(module.path);
		if (text === null) continue;
		let spec: Record<string, unknown> | null;
		try {
			spec = objectOf(parseYaml(text));
		} catch {
			continue;
		}
		const section = objectOf(spec?.research);
		if (section) {
			research ??= {
				module: module.directory,
				fixturesPath: join(module.path, RESEARCH_FIXTURES_FILE),
			};
			if (
				typeof section.adapter === 'string' &&
				LIVE_RESEARCH_ADAPTERS.has(section.adapter)
			) {
				live.push({
					module: module.directory,
					field: 'research.adapter',
					value: section.adapter,
				});
			}
		}
		for (const entry of Array.isArray(spec?.adapters) ? spec.adapters : []) {
			const adapter = objectOf(entry);
			if (
				adapter &&
				(typeof adapter.recorded !== 'string' || !adapter.recorded.trim())
			) {
				live.push({
					module: module.directory,
					field: `adapters[${String(adapter.id ?? '?').slice(0, 96)}].recorded`,
					value: 'missing, so the adapter could only call its connector',
				});
			}
		}
	}
	return { research, live };
}

export function liveAdapterRefusal(
	live: readonly LiveAdapterDeclaration[],
): string | null {
	if (live.length === 0) return null;
	return [
		`${LIVE_ADAPTER_REFUSED}: a sandbox session may declare only recorded adapters. An owner connects a live search or connector instance after delivery.`,
		...live.map(
			(entry) =>
				`- modules/${entry.module}/spec/module.yaml ${entry.field}: ${entry.value}`,
		),
		`Use research.adapter recorded with ${RESEARCH_FIXTURES_FILE} in the module, and a recorded fixture adapters/<id>.recorded.json for every adapter.`,
	].join('\n');
}

export function assertRecordedAdapters(adapters: SessionAdapters): void {
	const refusal = liveAdapterRefusal(adapters.live);
	if (refusal) throw new SandboxSetupError(LIVE_ADAPTER_REFUSED, refusal);
}

/* Setting values the preview holds fixed for every workspace, keyed by module.
   The adapter chain is held at the recorded adapter alone and switched on, and
   a chain holding recorded reads pages from the same fixtures before it looks
   at the fetch order, which stays at the default so Firecrawl is never added. */
export function recordedAdapterSettings(
	adapters: SessionAdapters,
): Readonly<Record<string, Readonly<Record<string, ModuleSettingValue>>>> {
	return adapters.research
		? {
				[RESEARCH_MODULE_ID]: {
					adapter: 'recorded',
					searchOrder: 'recorded',
					recordedEnabled: true,
					fetchOrder: 'direct',
					recordedFixturesPath: adapters.research.fixturesPath,
				},
			}
		: {};
}
