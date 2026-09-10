import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from 'node:crypto';
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

export function decodeWorkflowPayloadKey(value: string): Buffer {
	const trimmed = value.trim();
	const decoded = /^[0-9a-f]{64}$/i.test(trimmed)
		? Buffer.from(trimmed, 'hex')
		: Buffer.from(trimmed, 'base64');
	if (decoded.length !== 32) {
		throw new Error('FD_WORKFLOWS_PAYLOAD_KEY must encode exactly 32 bytes.');
	}
	return decoded;
}

export function createWorkflowPayloadCodec(key: Buffer): WorkflowPayloadCodec {
	if (key.length !== 32)
		throw new Error('Workflow payload encryption requires 32 bytes.');
	const keyId = `sha256:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
	return {
		keyId,
		encrypt(value, context) {
			const bytes = Buffer.from(JSON.stringify(value), 'utf8');
			if (bytes.length > WORKFLOW_LIMITS.maxEnvelopeBytes) {
				throw new Error('WORKFLOW_LIMIT_EXCEEDED');
			}
			const iv = randomBytes(12);
			const cipher = createCipheriv('aes-256-gcm', key, iv);
			cipher.setAAD(aad(context));
			const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
			return [
				'v1',
				keyId,
				iv.toString('base64url'),
				cipher.getAuthTag().toString('base64url'),
				encrypted.toString('base64url'),
			].join('.');
		},
		decrypt(ciphertext, context) {
			const [version, storedKeyId, encodedIv, encodedTag, encodedData] =
				ciphertext.split('.');
			if (
				version !== 'v1' ||
				storedKeyId !== keyId ||
				!encodedIv ||
				!encodedTag ||
				!encodedData
			) {
				throw new Error('WORKFLOW_PAYLOAD_UNREADABLE');
			}
			const decipher = createDecipheriv(
				'aes-256-gcm',
				key,
				Buffer.from(encodedIv, 'base64url'),
			);
			decipher.setAAD(aad(context));
			decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
			const clear = Buffer.concat([
				decipher.update(Buffer.from(encodedData, 'base64url')),
				decipher.final(),
			]);
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
