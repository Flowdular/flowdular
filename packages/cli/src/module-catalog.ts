import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
	ModuleCatalog,
	ModuleManifest,
	ModuleRelease,
} from '@flowdular/contracts';
import {
	assertModuleCompatibility,
	compareModuleVersions,
	createModuleRegistry,
	satisfiesModuleVersion,
	PLATFORM_API_VERSION,
} from '@flowdular/kernel';
import { distributionAssert, MAX_ARTIFACT_BYTES } from './module-artifact.ts';
import { validators } from './validation.ts';
import { resolveExistingInside } from './workspace.ts';

export const OFFICIAL_CATALOG =
	'https://raw.githubusercontent.com/Flowdular/official-modules/main/registry/index.json';
const OFFICIAL_PREFIX =
	'https://raw.githubusercontent.com/Flowdular/official-modules/';
export interface CatalogSource {
	readonly catalog: ModuleCatalog;
	readonly location: string;
}

export async function boundedRead(
	location: string,
	limit: number,
	fetcher: typeof fetch = fetch,
): Promise<Buffer> {
	if (!location.startsWith('https://')) {
		distributionAssert(
			(await stat(location)).size <= limit,
			'MODULE_DOWNLOAD_LIMIT',
			'Module metadata/artifact exceeds the size limit.',
		);
		const result = await readFile(location);
		distributionAssert(
			result.length <= limit,
			'MODULE_DOWNLOAD_LIMIT',
			'Module file grew beyond the size limit.',
		);
		return result;
	}
	distributionAssert(
		location.startsWith(OFFICIAL_PREFIX),
		'MODULE_SOURCE_UNTRUSTED',
		'Only the official HTTPS publisher is supported. Use an explicit local catalog for offline releases.',
	);
	const response = await fetcher(location, {
		redirect: 'error',
		signal: AbortSignal.timeout(30_000),
	});
	distributionAssert(
		response.ok && response.body,
		'MODULE_DOWNLOAD_FAILED',
		`Official module download failed (${response.status}).`,
	);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			distributionAssert(
				size <= limit,
				'MODULE_DOWNLOAD_LIMIT',
				'Module download exceeds the size limit.',
			);
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	return Buffer.concat(chunks);
}
export async function loadModuleCatalog(
	location = OFFICIAL_CATALOG,
	fetcher: typeof fetch = fetch,
): Promise<CatalogSource> {
	distributionAssert(
		location === OFFICIAL_CATALOG || !/^[a-z][a-z0-9+.-]*:/i.test(location),
		'MODULE_SOURCE_UNTRUSTED',
		'Use the official catalog or an explicit local catalog path.',
	);
	const catalog = JSON.parse(
		(await boundedRead(location, 4 * 1024 * 1024, fetcher)).toString('utf8'),
	) as ModuleCatalog;
	distributionAssert(
		validators.moduleCatalog(catalog) &&
			catalog &&
			catalog.schemaVersion === 1 &&
			Array.isArray(catalog.releases) &&
			catalog.releases.length <= 4096,
		'MODULE_CATALOG_INVALID',
		'Invalid module catalog.',
	);
	const identities = new Set<string>();
	for (const release of catalog.releases) {
		distributionAssert(
			release &&
				validators.module(release.manifest) &&
				/^@flowdular\/module-[a-z0-9-]+$/.test(release.manifest.package) &&
				typeof release.artifact === 'string' &&
				/^[a-f0-9]{64}$/.test(release.sha256) &&
				/^[a-f0-9]{40}$/.test(release.sourceCommit) &&
				typeof release.license === 'string' &&
				release.license.trim(),
			'MODULE_CATALOG_INVALID',
			'Invalid module release.',
		);
		assertModuleCompatibility(release.manifest, null);
		distributionAssert(
			release.manifest.platformApi,
			'MODULE_PLATFORM_REQUIRED',
			'Distributed modules must declare platformApi.',
		);
		const identity = release.manifest.id + '@' + release.manifest.version;
		distributionAssert(
			!identities.has(identity),
			'MODULE_CATALOG_DUPLICATE',
			`Duplicate release: ${identity}`,
		);
		identities.add(identity);
	}
	return { catalog, location };
}
export async function releaseLocation(
	source: CatalogSource,
	release: ModuleRelease,
): Promise<string> {
	if (source.location.startsWith('https://')) {
		const prefix = OFFICIAL_PREFIX + release.sourceCommit + '/';
		distributionAssert(
			release.artifact.startsWith(prefix) &&
				new URL(release.artifact).href === release.artifact &&
				!new URL(release.artifact).search &&
				!new URL(release.artifact).hash,
			'MODULE_SOURCE_UNTRUSTED',
			'Release artifact must be pinned to its official source commit.',
		);
		return release.artifact;
	}
	distributionAssert(
		!/^[a-z][a-z0-9+.-]*:/i.test(release.artifact),
		'MODULE_SOURCE_UNTRUSTED',
		'An offline catalog must use local artifacts.',
	);
	return resolveExistingInside(
		dirname(resolve(source.location)),
		release.artifact,
	);
}

/** Bounded backtracking: all dependents constrain a shared version, including diamonds. */
export function resolveModuleReleases(
	catalog: ModuleCatalog,
	target: string,
	installed: readonly ModuleManifest[],
): readonly ModuleRelease[] {
	const split = target.lastIndexOf('@');
	const id = split < 0 ? target : target.slice(0, split);
	const range = split < 0 ? '*' : target.slice(split + 1);
	distributionAssert(
		/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(id) && range,
		'MODULE_TARGET_INVALID',
		'Use module.id or module.id@version/range.',
	);
	const existing = new Map(
		installed.map((manifest) => [manifest.id, manifest]),
	);
	const candidates = new Map<string, ModuleRelease[]>();
	for (const release of catalog.releases) {
		const entries = candidates.get(release.manifest.id) ?? [];
		entries.push(release);
		candidates.set(release.manifest.id, entries);
	}
	for (const entries of candidates.values())
		entries.sort((a, b) =>
			compareModuleVersions(a.manifest.version, b.manifest.version),
		);
	let attempts = 0;
	function search(
		selected: Map<string, ModuleRelease>,
		pending: readonly { id: string; range: string }[],
	): Map<string, ModuleRelease> | undefined {
		distributionAssert(
			++attempts <= 10_000 && pending.length <= 4096 && selected.size <= 256,
			'MODULE_RESOLUTION_LIMIT',
			'Module dependency resolution limit exceeded.',
		);
		const [next, ...rest] = pending;
		if (!next) return selected;
		const fixed = selected.get(next.id)?.manifest ?? existing.get(next.id);
		if (fixed)
			return satisfiesModuleVersion(fixed.version, next.range)
				? search(selected, rest)
				: undefined;
		for (const candidate of candidates.get(next.id) ?? []) {
			if (
				!satisfiesModuleVersion(candidate.manifest.version, next.range) ||
				!satisfiesModuleVersion(
					PLATFORM_API_VERSION,
					candidate.manifest.platformApi!,
				)
			)
				continue;
			const found = search(new Map([...selected, [next.id, candidate]]), [
				...candidate.manifest.dependencies,
				...rest,
			]);
			if (found) return found;
		}
		return undefined;
	}
	const selected = search(new Map(), [{ id, range }]);
	distributionAssert(
		selected,
		'MODULE_RESOLUTION_FAILED',
		`No compatible dependency closure for ${target}. Installed versions are preserved.`,
	);
	const all = [
		...installed,
		...[...selected.values()].map((release) => release.manifest),
	];
	const registry = createModuleRegistry(all.map((manifest) => ({ manifest })));
	return registry.modules.flatMap((module) => {
		const release = selected.get(module.manifest.id);
		return release ? [release] : [];
	});
}
export async function readRelease(
	source: CatalogSource,
	release: ModuleRelease,
	fetcher: typeof fetch = fetch,
): Promise<Buffer> {
	return boundedRead(
		await releaseLocation(source, release),
		MAX_ARTIFACT_BYTES,
		fetcher,
	);
}
