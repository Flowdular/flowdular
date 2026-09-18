import {
	compareVersions,
	isValidRange,
	nextVersion,
	parseVersion,
	rangeSatisfies,
} from './version-range.ts';
import {
	PLATFORM_API_VERSION,
	type ModuleManifest,
} from '@flowdular/contracts';
import { RegistryError } from './errors.ts';

export { PLATFORM_API_VERSION };

export type ModuleVersionLevel = 'patch' | 'minor' | 'major';

export function incrementModuleVersion(
	version: string,
	level: ModuleVersionLevel,
): string {
	const next = nextVersion(version, level);
	if (!next)
		throw new RegistryError(
			'MODULE_VERSION_INVALID',
			`Cannot bump invalid version ${version}.`,
		);
	return next;
}

/* A dependent's range is left alone while it still accepts the new version.
   Otherwise the version part is replaced and the operator kept, so `^0.11.0`
   becomes `^0.12.0` and an exact pin stays an exact pin. A compound range is
   returned as null for the caller to retarget by hand. */
export function retargetModuleRange(
	range: string,
	version: string,
): string | null {
	if (satisfiesModuleVersion(version, range)) return range;
	const simple = /^([\^~]?)\d+\.\d+\.\d+$/.exec(range.trim());
	if (!simple) return null;
	return `${simple[1]}${version}`;
}

export function satisfiesModuleVersion(
	version: string,
	range: string,
): boolean {
	return rangeSatisfies(version, range);
}

/** Newest first, the order a catalog lists releases in. */
export function compareModuleVersions(left: string, right: string): number {
	const first = parseVersion(left);
	const second = parseVersion(right);
	if (!first || !second) return 0;
	return compareVersions(second, first);
}

export function assertModuleCompatibility(
	manifest: ModuleManifest,
	platformVersion: string | null = PLATFORM_API_VERSION,
): void {
	if (parseVersion(manifest.version) === null)
		throw new RegistryError(
			'MODULE_VERSION_INVALID',
			`Invalid version for ${manifest.id}: ${manifest.version}`,
		);
	if (
		manifest.platformApi !== undefined &&
		(!isValidRange(manifest.platformApi) ||
			(platformVersion !== null &&
				!satisfiesModuleVersion(platformVersion, manifest.platformApi)))
	) {
		throw new RegistryError(
			'MODULE_PLATFORM_INCOMPATIBLE',
			`${manifest.id} requires platform API ${manifest.platformApi}; available ${PLATFORM_API_VERSION}.`,
		);
	}
	const ids = new Set<string>();
	for (const dependency of manifest.dependencies) {
		if (!dependency.range.trim() || !isValidRange(dependency.range))
			throw new RegistryError(
				'MODULE_RANGE_INVALID',
				`${manifest.id} declares an invalid range for ${dependency.id}: ${dependency.range}`,
			);
		if (ids.has(dependency.id))
			throw new RegistryError(
				'MODULE_DEPENDENCY_DUPLICATE',
				`${manifest.id} declares ${dependency.id} more than once.`,
			);
		ids.add(dependency.id);
	}
}

export function assertModuleDependency(
	consumer: string,
	dependency: { id: string; range: string },
	version: string,
): void {
	if (!satisfiesModuleVersion(version, dependency.range)) {
		throw new RegistryError(
			'MODULE_DEPENDENCY_INCOMPATIBLE',
			`${consumer} requires ${dependency.id} ${dependency.range}; available ${version}.`,
		);
	}
}
