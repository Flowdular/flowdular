import {
	createKeyring,
	KeyringError,
	keyFingerprint,
	type Keyring,
} from '@flowdular/kernel';
import type {
	JsonSchemaV1,
	JsonValue,
	WorkflowPayloadEvidenceV1,
} from '../domain/types.ts';
import { WORKFLOW_LIMITS } from '../domain/types.ts';
import { jsonByteSize, jsonHash } from '../domain/graph.ts';

const SECRET_KEY =
	/(?:password|secret|token|credential|api[-_]?key|authorization)/i;

export interface WorkflowPayloadCodec {
	readonly keyId: string;
	encrypt(
		value: JsonValue,
		context: {
			readonly tenantId: string;
			readonly runId: string;
			readonly payloadId: string;
		},
	): string;
	decrypt(
		ciphertext: string,
		context: {
			readonly tenantId: string;
			readonly runId: string;
			readonly payloadId: string;
		},
	): JsonValue;
}

function aad(context: {
	readonly tenantId: string;
	readonly runId: string;
	readonly payloadId: string;
}): Buffer {
	return Buffer.from(
		`${context.tenantId}\u0000${context.runId}\u0000${context.payloadId}`,
		'utf8',
	);
}

export function decodeWorkflowPayloadKey(
	value: string,
	variable = 'FD_WORKFLOWS_PAYLOAD_KEY',
): Buffer {
	const trimmed = value.trim();
	const decoded = /^[0-9a-f]{64}$/i.test(trimmed)
		? Buffer.from(trimmed, 'hex')
		: Buffer.from(trimmed, 'base64');
	if (decoded.length !== 32) {
		throw new Error(`${variable} must encode exactly 32 bytes.`);
	}
	return decoded;
}

/* The stored envelope spells the key id with the digest it came from. The ring
   holds the bare fingerprint, so the prefix is added on the way out and
   stripped on the way in; stored rows keep the format they were written in. */
const KEY_ID_PREFIX = 'sha256:';

export function workflowPayloadKeyId(key: Buffer): string {
	return `${KEY_ID_PREFIX}${keyFingerprint(key)}`;
}

/**
 * `previous` holds the payload keys a rotation has not finished retiring. They
 * open stored payloads; every new payload is sealed with `key`.
 */
export function createWorkflowPayloadCodec(
	key: Buffer,
	previous: readonly Buffer[] = [],
): WorkflowPayloadCodec {
	if (key.length !== 32)
		throw new Error('Workflow payload encryption requires 32 bytes.');
	const keyring: Keyring = createKeyring({ current: key, previous });
	const keyId = `${KEY_ID_PREFIX}${keyring.keyId}`;
	return {
		keyId,
		encrypt(value, context) {
			const bytes = Buffer.from(JSON.stringify(value), 'utf8');
			if (bytes.length > WORKFLOW_LIMITS.maxEnvelopeBytes) {
				throw new Error('WORKFLOW_LIMIT_EXCEEDED');
			}
			const sealed = keyring.seal(bytes, aad(context));
			return [
				'v1',
				keyId,
				sealed.iv.toString('base64url'),
				sealed.tag.toString('base64url'),
				sealed.ciphertext.toString('base64url'),
			].join('.');
		},
		decrypt(ciphertext, context) {
			const [version, storedKeyId, encodedIv, encodedTag, encodedData] =
				ciphertext.split('.');
			if (
				version !== 'v1' ||
				!storedKeyId?.startsWith(KEY_ID_PREFIX) ||
				!encodedIv ||
				!encodedTag ||
				!encodedData
			) {
				throw new Error('WORKFLOW_PAYLOAD_UNREADABLE');
			}
			let clear: Buffer;
			try {
				clear = keyring.open(
					{
						keyId: storedKeyId.slice(KEY_ID_PREFIX.length),
						iv: Buffer.from(encodedIv, 'base64url'),
						tag: Buffer.from(encodedTag, 'base64url'),
						ciphertext: Buffer.from(encodedData, 'base64url'),
					},
					aad(context),
				);
			} catch (error) {
				if (error instanceof KeyringError) {
					throw new Error('WORKFLOW_PAYLOAD_UNREADABLE', { cause: error });
				}
				throw error;
			}
			return JSON.parse(clear.toString('utf8')) as JsonValue;
		},
	};
}

interface EvidencePolicy {
	readonly schema?: JsonSchemaV1;
	readonly permissionSnapshot?: readonly string[];
}

type RedactionReason = 'secret' | 'scope-denied';

function schemaRecord(
	schema: JsonSchemaV1 | undefined,
	key: string,
): JsonSchemaV1 | undefined {
	const properties = schema?.['properties'];
	if (
		!properties ||
		typeof properties !== 'object' ||
		Array.isArray(properties)
	)
		return undefined;
	const child = (properties as Readonly<Record<string, JsonValue>>)[key];
	return child && typeof child === 'object' && !Array.isArray(child)
		? (child as JsonSchemaV1)
		: undefined;
}

function schemaItems(
	schema: JsonSchemaV1 | undefined,
): JsonSchemaV1 | undefined {
	const items = schema?.items;
	return items && typeof items === 'object' && !Array.isArray(items)
		? (items as JsonSchemaV1)
		: undefined;
}

function schemaReason(
	schema: JsonSchemaV1 | undefined,
	permissions: readonly string[],
): RedactionReason | null {
	if (
		schema?.writeOnly === true ||
		schema?.['x-flowdular-secret'] === true ||
		schema?.['x-coreloom-secret'] === true
	) {
		return 'secret';
	}
	const requiredPermissions = [
		schema?.['x-flowdular-read-permission'],
		schema?.['x-coreloom-read-permission'],
	];
	if (
		requiredPermissions.some(
			(permission) =>
				typeof permission === 'string' && !permissions.includes(permission),
		)
	) {
		return 'scope-denied';
	}
	return null;
}

function redact(
	value: JsonValue,
	schema: JsonSchemaV1 | undefined,
	permissions: readonly string[],
): {
	readonly value: JsonValue;
	readonly changed: boolean;
	readonly reason: RedactionReason | null;
} {
	const ownReason = schemaReason(schema, permissions);
	if (ownReason) {
		return { value: '[redacted]', changed: true, reason: ownReason };
	}
	if (value === null || typeof value !== 'object') {
		return { value, changed: false, reason: null };
	}
	if (Array.isArray(value)) {
		let changed = false;
		let reason: RedactionReason | null = null;
		const result = value.map((entry) => {
			const child = redact(entry, schemaItems(schema), permissions);
			changed ||= child.changed;
			reason ??= child.reason;
			return child.value;
		});
		return { value: result, changed, reason };
	}
	let changed = false;
	let reason: RedactionReason | null = null;
	const result: Record<string, JsonValue> = {};
	for (const [key, entry] of Object.entries(value)) {
		const childSchema = schemaRecord(schema, key);
		const childReason = schemaReason(childSchema, permissions);
		if (SECRET_KEY.test(key) || childReason) {
			result[key] = '[redacted]';
			changed = true;
			reason ??= childReason ?? 'secret';
			continue;
		}
		const child = redact(entry, childSchema, permissions);
		result[key] = child.value;
		changed ||= child.changed;
		reason ??= child.reason;
	}
	return { value: result, changed, reason };
}

export function safePayloadEvidence(
	value: JsonValue | undefined,
	schemaId: string,
	policy: EvidencePolicy = {},
): WorkflowPayloadEvidenceV1 {
	if (value === undefined) {
		return {
			version: 1,
			state: 'absent',
			schemaId,
			hash: jsonHash(null),
			originalByteSize: 0,
			reason: 'not-emitted',
		};
	}
	const originalByteSize = jsonByteSize(value);
	const hash = jsonHash(value);
	const safe = redact(value, policy.schema, policy.permissionSnapshot ?? []);
	if (safe.changed) {
		return {
			version: 1,
			state: 'redacted',
			schemaId,
			hash,
			originalByteSize,
			preview: safe.value,
			reason: safe.reason ?? 'secret',
		};
	}
	if (originalByteSize > 8 * 1024) {
		return {
			version: 1,
			state: 'truncated',
			schemaId,
			hash,
			originalByteSize,
			reason: 'size-limit',
		};
	}
	return {
		version: 1,
		state: 'available',
		schemaId,
		hash,
		originalByteSize,
		preview: structuredClone(value),
	};
}
