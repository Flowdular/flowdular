/**
 * The public cross-module surface. A module registers the adapters its
 * specification declares while it composes:
 * `context.capabilities.get<AdapterRegistry>(ADAPTERS_SOURCES_CAPABILITY)?.register('vendors.core', [...])`.
 *
 * adapters.core never calls another system itself and never writes another
 * module's records: a source writes through `import.write.v1`, a sink reads
 * through `exports.lists.v1`, and every call leaves through
 * `connectors.calls.v1` on the instance a workspace owner bound.
 */
export const ADAPTERS_SOURCES_CAPABILITY = 'adapters.sources.v1';
export const ADAPTERS_SINKS_CAPABILITY = 'adapters.sinks.v1';

export type AdapterJson =
	| string
	| number
	| boolean
	| null
	| readonly AdapterJson[]
	| { readonly [key: string]: AdapterJson };

export type AdapterJsonObject = { readonly [key: string]: AdapterJson };

export const ADAPTER_DIRECTIONS = ['source', 'sink'] as const;
export type AdapterDirection = (typeof ADAPTER_DIRECTIONS)[number];

export const ADAPTER_TRANSFORMS = [
	'rename',
	'constant',
	'format',
	'lookup',
] as const;
export type AdapterTransform = (typeof ADAPTER_TRANSFORMS)[number];

export const ADAPTER_IMPORT_MODES = [
	'create-only',
	'update-existing',
	'skip-existing',
] as const;
export type AdapterImportMode = (typeof ADAPTER_IMPORT_MODES)[number];

/**
 * One rule of a mapping, applied in order. `from` is a dotted path into the
 * source record (a list column key for a sink), `to` a port field id for a
 * source and a dotted path of the pushed record for a sink. `format` names one
 * of `trim`, `lower`, `upper`, `integer`, `decimal`, `boolean`, `iso-date` or
 * `date:<layout>` in `value`; `lookup` replaces the value through `table`.
 */
export interface AdapterMappingRule {
	readonly from?: string | undefined;
	readonly to: string;
	readonly transform: AdapterTransform;
	readonly value?: string | null | undefined;
	readonly table?: Readonly<Record<string, string>> | undefined;
}

/**
 * How a source walks an operation. `cursor` writes the stored cursor at the
 * input path `param` and reads the next one from the answer path `next`;
 * `page` writes a page number from `start` (1 by default) and stops on a page
 * without records.
 */
export type AdapterPaging =
	| {
			readonly kind: 'cursor';
			readonly param: string;
			readonly next: string;
	  }
	| {
			readonly kind: 'page';
			readonly param: string;
			readonly start?: number | undefined;
	  };

/** One answer the recorded mode replays: the body the call with this input got. */
export interface AdapterRecordedCall {
	readonly input: AdapterJsonObject;
	readonly body: AdapterJson;
}

/** The parsed `adapters/<name>.recorded.json` of the registering module. */
export interface AdapterRecordedFixture {
	readonly adapter: string;
	readonly operation: string;
	readonly calls: readonly AdapterRecordedCall[];
}

export interface AdapterRegistration {
	/** `<module id>.<key>`, the spec's adapter id. */
	readonly id: string;
	readonly direction: AdapterDirection;
	readonly label: string;
	/** The connector definition key an owner's instance must be of. */
	readonly connector: string;
	readonly operation: string;
	/** An import target for a source; a list export of this module for a sink. */
	readonly port: string;
	/** A five-field cron in the workspace zone; absent or null runs on demand. */
	readonly schedule?: string | null | undefined;
	readonly mapping: readonly AdapterMappingRule[];
	readonly recorded?: AdapterRecordedFixture | undefined;
	/** The operation input every call starts from. */
	readonly input?: AdapterJsonObject | undefined;
	/**
	 * Source: the answer path of the record array, empty for the answer itself.
	 * Sink: the input path a batch of mapped rows is placed at.
	 */
	readonly items?: string | undefined;
	/** Source only; absent reads one page. */
	readonly paging?: AdapterPaging | undefined;
	/** Source only; `update-existing` by default. */
	readonly mode?: AdapterImportMode | undefined;
	/** Sink only; rows per push, 50 by default and at most 200. */
	readonly batchSize?: number | undefined;
}

export interface AdapterRegistry {
	/**
	 * Open while the platform composes and sealed when adapters.core starts. An
	 * id must be the registering module id followed by a key, and a sink pushes
	 * a list of the registering module only.
	 */
	register(moduleId: string, adapters: readonly AdapterRegistration[]): void;
}
