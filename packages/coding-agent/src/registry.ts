import {
	CodingAgentError,
	type CodingAgentAvailability,
	type CodingAgentDriver,
	type CodingAgentDriverInfo,
	type SandboxRuntimeMode,
} from './types.ts';

export interface DriverStatus extends CodingAgentDriverInfo {
	readonly availability: CodingAgentAvailability;
	readonly offered: boolean;
	readonly blockedReason: string | null;
}

export interface CodingAgentRegistry {
	readonly mode: SandboxRuntimeMode;
	drivers(): readonly CodingAgentDriverInfo[];
	status(): Promise<readonly DriverStatus[]>;
	resolve(id: string): Promise<CodingAgentDriver>;
}

export interface CodingAgentRegistryOptions {
	readonly mode: SandboxRuntimeMode;
	readonly drivers: readonly CodingAgentDriver[];
	/* Availability rarely changes inside one sandbox run, so probes are cached
	   for this window instead of shelling out on every request. */
	readonly probeCacheMs?: number;
}

const DEFAULT_PROBE_CACHE_MS = 60_000;

function info(driver: CodingAgentDriver): CodingAgentDriverInfo {
	return {
		id: driver.id,
		label: driver.label,
		kind: driver.kind,
		requiresLoopback: driver.requiresLoopback,
		description: driver.description,
	};
}

export function createCodingAgentRegistry(
	options: CodingAgentRegistryOptions,
): CodingAgentRegistry {
	const drivers = new Map<string, CodingAgentDriver>();
	for (const driver of options.drivers) {
		if (drivers.has(driver.id)) {
			throw new CodingAgentError(
				'DUPLICATE_DRIVER',
				`Driver ${driver.id} is already registered.`,
			);
		}
		drivers.set(driver.id, driver);
	}
	const cache = new Map<
		string,
		{ readonly at: number; readonly value: CodingAgentAvailability }
	>();
	const cacheMs = options.probeCacheMs ?? DEFAULT_PROBE_CACHE_MS;

	/* A local binary carries the operator's own login and file system reach, so
	   only a loopback sandbox may offer it. */
	const blockedReason = (driver: CodingAgentDriver): string | null =>
		driver.requiresLoopback && options.mode !== 'loopback'
			? 'Local agent binaries are offered only by a loopback sandbox.'
			: null;

	const probe = async (
		driver: CodingAgentDriver,
	): Promise<CodingAgentAvailability> => {
		const cached = cache.get(driver.id);
		const now = Date.now();
		if (cached && now - cached.at < cacheMs) return cached.value;
		const value = await driver.probe();
		cache.set(driver.id, { at: now, value });
		return value;
	};

	return {
		mode: options.mode,
		drivers: () => [...drivers.values()].map(info),
		status: async () =>
			Promise.all(
				[...drivers.values()].map(async (driver) => {
					const blocked = blockedReason(driver);
					const availability = blocked
						? { available: false, detail: blocked, version: null }
						: await probe(driver);
					return {
						...info(driver),
						availability,
						offered: !blocked && availability.available,
						blockedReason: blocked,
					};
				}),
			),
		resolve: async (id: string) => {
			const driver = drivers.get(id);
			if (!driver) {
				throw new CodingAgentError(
					'UNKNOWN_DRIVER',
					`Unknown coding agent driver: ${id}`,
				);
			}
			const blocked = blockedReason(driver);
			if (blocked) {
				throw new CodingAgentError('DRIVER_NOT_OFFERED', blocked);
			}
			const availability = await probe(driver);
			if (!availability.available) {
				throw new CodingAgentError(
					'DRIVER_UNAVAILABLE',
					`${driver.label} is not available: ${availability.detail}`,
				);
			}
			return driver;
		},
	};
}
