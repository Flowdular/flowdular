import { METER_LIMITS, type MeterDeclaration } from '../domain/meters.ts';
import { METER_KINDS, type MeterKind } from '../domain/types.ts';
import { MeteringServiceError } from './service-error.ts';

const MODULE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const METER_KEY = /^[a-z][a-z0-9-]*$/;

function refuse(message: string): never {
	throw new MeteringServiceError('METER_DECLARATION_INVALID', message, 500);
}

/** A meter as the registry resolved it: the full key and who owns it. */
export interface DeclaredMeter {
	readonly moduleId: string;
	/** `${moduleId}.${declaration.key}`, the key facts are reported under. */
	readonly key: string;
	readonly label: string;
	readonly unit: string;
	readonly kind: MeterKind;
}

/**
 * The declaration half of `metering.meters.v1`. It is filled while the platform
 * composes and sealed before requests run, so every fact is checked against the
 * same set of meters for the life of the process.
 */
export class MeterDeclarationRegistry {
	/** Declaration order, so the registry reads the way composition ran. */
	readonly #modules = new Map<string, readonly DeclaredMeter[]>();
	/** Full key to meter, so resolving one is O(1) on the recording path. */
	readonly #meters = new Map<string, DeclaredMeter>();
	#sealed = false;

	declare(moduleId: string, meters: readonly MeterDeclaration[]): void {
		if (this.#sealed) {
			refuse(
				`${moduleId} declared meters after the platform started; declarations are accepted during composition only.`,
			);
		}
		if (
			typeof moduleId !== 'string' ||
			moduleId.length > METER_LIMITS.moduleId ||
			!MODULE_ID.test(moduleId)
		) {
			refuse(`"${String(moduleId)}" is not a module id.`);
		}
		if (this.#modules.has(moduleId)) {
			refuse(`${moduleId} declared its meters twice.`);
		}
		if (!Array.isArray(meters)) {
			refuse(`${moduleId} declared something other than a list of meters.`);
		}
		if (meters.length > METER_LIMITS.metersPerModule) {
			refuse(
				`${moduleId} declared ${meters.length} meters; at most ${METER_LIMITS.metersPerModule} are accepted.`,
			);
		}
		const accepted = meters.map((declaration) =>
			validated(moduleId, declaration),
		);
		/* Nothing is recorded until every meter of the module validated, so a
		   refused declaration leaves the registry exactly as it was. */
		const seen = new Set<string>();
		for (const meter of accepted) {
			const taken = this.#meters.get(meter.key);
			if (taken) {
				refuse(
					`${moduleId} declared ${meter.key}, which ${taken.moduleId} already owns.`,
				);
			}
			if (seen.has(meter.key)) {
				refuse(`${moduleId} declared ${meter.key} twice.`);
			}
			seen.add(meter.key);
		}
		this.#modules.set(moduleId, accepted);
		for (const meter of accepted) this.#meters.set(meter.key, meter);
	}

	/** The owner of one full key, or null when no composed module declared it. */
	resolve(key: string): DeclaredMeter | null {
		return this.#meters.get(key) ?? null;
	}

	/** Every declared meter, flattened, in declaration order. */
	list(): readonly DeclaredMeter[] {
		return [...this.#meters.values()];
	}

	/** Called once the platform started; later declarations are refused. */
	seal(): void {
		this.#sealed = true;
	}

	get sealed(): boolean {
		return this.#sealed;
	}
}

function validated(
	moduleId: string,
	declaration: MeterDeclaration,
): DeclaredMeter {
	if (typeof declaration !== 'object' || declaration === null) {
		refuse(`${moduleId} declared something other than a meter.`);
	}
	const key = declaration.key;
	if (typeof key !== 'string' || !METER_KEY.test(key)) {
		refuse(`${moduleId} declared "${String(key)}", which is not a meter key.`);
	}
	const fullKey = `${moduleId}.${key}`;
	if (fullKey.length > METER_LIMITS.key) {
		refuse(`${fullKey} is longer than ${METER_LIMITS.key} characters.`);
	}
	const label = declaration.label;
	if (
		typeof label !== 'string' ||
		label.trim().length < 1 ||
		label.length > METER_LIMITS.label
	) {
		refuse(
			`${fullKey} needs a label of 1 to ${METER_LIMITS.label} characters.`,
		);
	}
	const unit = declaration.unit;
	if (
		typeof unit !== 'string' ||
		unit.trim().length < 1 ||
		unit.length > METER_LIMITS.unit
	) {
		refuse(`${fullKey} needs a unit of 1 to ${METER_LIMITS.unit} characters.`);
	}
	if (!(METER_KINDS as readonly string[]).includes(declaration.kind)) {
		refuse(
			`${fullKey} must be one of: ${METER_KINDS.join(', ')}, not "${String(declaration.kind)}".`,
		);
	}
	return {
		moduleId,
		key: fullKey,
		label: label.trim(),
		unit: unit.trim(),
		kind: declaration.kind,
	};
}
