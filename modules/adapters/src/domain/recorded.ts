import type {
	AdapterJson,
	AdapterJsonObject,
	AdapterRecordedFixture,
} from './registry.ts';

function equal(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((item, index) => equal(item, right[index]))
		);
	}
	if (
		typeof left !== 'object' ||
		typeof right !== 'object' ||
		left === null ||
		right === null
	) {
		return false;
	}
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key) =>
				Object.hasOwn(right, key) &&
				equal(
					(left as Record<string, unknown>)[key],
					(right as Record<string, unknown>)[key],
				),
		)
	);
}

/* Every key of the recorded input is present with the same value in the call
   input; objects are compared the same way at every depth, arrays exactly. */
function contained(recorded: unknown, actual: unknown): boolean {
	if (
		typeof recorded === 'object' &&
		recorded !== null &&
		!Array.isArray(recorded)
	) {
		if (
			typeof actual !== 'object' ||
			actual === null ||
			Array.isArray(actual)
		) {
			return false;
		}
		return Object.entries(recorded).every(
			([key, value]) =>
				Object.hasOwn(actual, key) &&
				contained(value, (actual as Record<string, unknown>)[key]),
		);
	}
	return equal(recorded, actual);
}

/**
 * The recorded body for a call input: the first call whose input equals it,
 * else the first whose input it contains, so a fixture pins a page exactly and
 * a push by the fields that matter. Undefined when no call matches.
 */
export function recordedAnswer(
	fixture: AdapterRecordedFixture,
	input: AdapterJsonObject,
): AdapterJson | undefined {
	const exact = fixture.calls.find((call) => equal(call.input, input));
	if (exact) return exact.body;
	return fixture.calls.find((call) => contained(call.input, input))?.body;
}
