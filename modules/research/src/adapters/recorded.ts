import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import type { ResearchResult } from '../domain/capability.ts';
import {
	RESEARCH_LIMITS,
	type ResearchFixtures,
	type ResearchSettings,
} from '../domain/types.ts';
import { boundResults } from '../services/results.ts';
import { ResearchServiceError } from '../services/service-error.ts';
import type { ResearchAdapter } from './types.ts';

export const RECORDED_FIXTURES_FILE = 'research-fixtures.json';

function unavailable(message: string): ResearchServiceError {
	return new ResearchServiceError(
		'RESEARCH_FIXTURES_UNAVAILABLE',
		message,
		409,
	);
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export interface RecordedAdapter extends ResearchAdapter {
	readonly key: 'recorded';
	page(
		settings: ResearchSettings,
		url: string,
	): Promise<{ readonly title: string; readonly text: string } | null>;
}

/**
 * Answers from research-fixtures.json: searches by the exact query, pages by
 * the exact URL. The path is absolute, as the sandbox preview pins it, or
 * relative to the workspace root, and the file must carry that name, so a
 * workspace setting can never point the adapter at another file.
 */
export function createRecordedAdapter(workspaceRoot: string): RecordedAdapter {
	const load = async (
		settings: ResearchSettings,
	): Promise<ResearchFixtures> => {
		const configured = settings.recordedFixturesPath.trim();
		if (configured === '') {
			throw unavailable('No recorded fixtures file is configured.');
		}
		const path = isAbsolute(configured)
			? configured
			: resolve(workspaceRoot, configured);
		if (basename(path) !== RECORDED_FIXTURES_FILE) {
			throw unavailable(
				`The recorded fixtures file must be named ${RECORDED_FIXTURES_FILE}.`,
			);
		}
		let parsed: unknown;
		try {
			if ((await stat(path)).size > RESEARCH_LIMITS.fixturesBytes) {
				throw new Error('too large');
			}
			parsed = JSON.parse(await readFile(path, 'utf8'));
		} catch {
			throw unavailable('The recorded fixtures file could not be read.');
		}
		const value = record(parsed);
		return {
			queries: record(value.queries) as ResearchFixtures['queries'],
			pages: record(value.pages) as ResearchFixtures['pages'],
		};
	};

	return {
		key: 'recorded',
		async search(input): Promise<readonly ResearchResult[]> {
			const fixtures = await load(input.settings);
			return Object.hasOwn(fixtures.queries, input.query)
				? boundResults(fixtures.queries[input.query])
				: [];
		},
		async page(settings, url) {
			const fixtures = await load(settings);
			if (!Object.hasOwn(fixtures.pages, url)) return null;
			const page = record(fixtures.pages[url]);
			return {
				title: typeof page.title === 'string' ? page.title : '',
				text: typeof page.text === 'string' ? page.text : '',
			};
		},
	};
}
