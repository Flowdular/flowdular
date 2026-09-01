import type { CommandEnvelope } from '@coreloom/cli-protocol';

interface CapabilityLine {
	readonly id: string;
	readonly risk: string;
	readonly summary: string;
}

/* Any command may return a "capabilities" field. Only a descriptor list is
   rendered as the capability table; everything else falls through to JSON. */
function isCapabilityList(
	values: readonly unknown[],
): values is readonly CapabilityLine[] {
	return values.every(
		(value) =>
			typeof value === 'object' &&
			value !== null &&
			typeof (value as CapabilityLine).id === 'string' &&
			typeof (value as CapabilityLine).risk === 'string' &&
			typeof (value as CapabilityLine).summary === 'string',
	);
}

export function renderOutput(envelope: CommandEnvelope, json: boolean): string {
	if (json) return JSON.stringify(envelope, null, 2);
	if (!envelope.ok)
		return `ERROR ${envelope.error?.code ?? 'UNKNOWN'}\n${envelope.error?.message ?? 'Command failed.'}`;

	const decorate = (body: string): string =>
		[
			body,
			...envelope.warnings.map((warning) => `WARNING ${warning}`),
			...envelope.evidence.map((item) => `EVIDENCE ${item}`),
		].join('\n');
	const data = envelope.data as Record<string, unknown> | undefined;
	if (data && Array.isArray(data.checks)) {
		return decorate(
			data.checks
				.map((check) => {
					const value = check as {
						status: string;
						id: string;
						message: string;
					};
					return `${value.status === 'pass' ? 'PASS' : value.status.toUpperCase()} ${value.id}  ${value.message}`;
				})
				.join('\n'),
		);
	}
	if (
		data &&
		Array.isArray(data.capabilities) &&
		isCapabilityList(data.capabilities)
	) {
		return decorate(
			data.capabilities
				.map(
					(value) =>
						`${value.id.padEnd(22)} ${value.risk.padEnd(16)} ${value.summary}`,
				)
				.join('\n'),
		);
	}
	return decorate(JSON.stringify(data, null, 2));
}
