import { ADAPTER_LIMITS } from './types.ts';
import type { AdapterJson, AdapterJsonObject } from './registry.ts';

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/** A dotted path of plain keys; the empty path names the value itself. */
export function validPath(path: unknown, allowEmpty: boolean): path is string {
	if (typeof path !== 'string') return false;
	if (path === '') return allowEmpty;
	if (path.length > ADAPTER_LIMITS.path) return false;
	const segments = path.split('.');
	return (
		segments.length <= ADAPTER_LIMITS.pathSegments &&
		segments.every((segment) => SEGMENT.test(segment) && !RESERVED.has(segment))
	);
}

function plainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value at a path, or undefined when any step is missing. */
export function readPath(value: unknown, path: string): unknown {
	if (path === '') return value;
	let current: unknown = value;
	for (const segment of path.split('.')) {
		if (!plainObject(current) || !Object.hasOwn(current, segment)) {
			return undefined;
		}
		current = current[segment];
	}
	return current;
}

/**
 * A copy of `target` with `value` at `path`, every object along the path copied
 * rather than changed, so a registered input is never altered by a call.
 */
export function writePath(
	target: AdapterJsonObject,
	path: string,
	value: AdapterJson,
): AdapterJsonObject {
	const [head, ...rest] = path.split('.');
	const key = head!;
	if (rest.length === 0) return { ...target, [key]: value };
	const child = target[key];
	return {
		...target,
		[key]: writePath(
			plainObject(child) ? (child as AdapterJsonObject) : {},
			rest.join('.'),
			value,
		),
	};
}

/** Serialized size of a JSON value, or null when it is not plain JSON. */
export function jsonSize(value: unknown): number | null {
	try {
		const text = JSON.stringify(value);
		return typeof text === 'string' ? text.length : null;
	} catch {
		return null;
	}
}
