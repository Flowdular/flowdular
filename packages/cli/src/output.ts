import type { CommandEnvelope } from '@flowdular/cli-protocol';
import { styleText } from 'node:util';

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

export function renderOutput(
	envelope: CommandEnvelope,
	json: boolean,
	color = false,
): string {
	if (json) return JSON.stringify(envelope, null, 2);
	const paint = (text: string, format: 'bold' | 'cyan' | 'green') =>
		color ? styleText(format, text, { validateStream: false }) : text;
	if (!envelope.ok) {
		const heading = `ERROR ${envelope.error?.code ?? 'UNKNOWN'}\n${envelope.error?.message ?? 'Command failed.'}`;
		if (envelope.error?.code !== 'DOCTOR_FAILED') return heading;
		const details = envelope.error.details as { checks?: unknown } | undefined;
		if (!Array.isArray(details?.checks)) return heading;
		const failures = details.checks.filter(
			(check) =>
				check &&
				check.status === 'fail' &&
				typeof check.id === 'string' &&
				typeof check.message === 'string',
		);
		return [
			heading,
			...failures.map((check) => `FAIL ${check.id}  ${check.message}`),
		].join('\n');
	}

	const decorate = (body: string): string =>
		[
			body,
			...envelope.warnings.map((warning) => `WARNING ${warning}`),
			...envelope.evidence.map((item) => `EVIDENCE ${item}`),
		].join('\n');
	const data = envelope.data as Record<string, unknown> | undefined;
	if (data?.cancelled === true) return decorate('Setup cancelled.');
	if (data?.setup === 'postgresql')
		return [
			'',
			`  ${paint('FLOWDULAR', 'bold')}  ${paint('PostgreSQL configured', 'green')}`,
			'',
			'  PostgreSQL settings saved to .env.',
			'',
			`  Start app    ${paint('pnpm dev', 'bold')}`,
			`  Local URL    ${paint('http://localhost:4310', 'cyan')}`,
			'  Open the app to create an account.',
			'',
			...envelope.warnings.map((warning) => `  ${warning}`),
			'',
		].join('\n');
	if (data?.setup === 'local') {
		const admin = (
			data.accounts as
				| { admin?: { email?: string; password?: string } }
				| undefined
		)?.admin;
		return [
			'',
			`  ${paint('FLOWDULAR', 'bold')}  ${paint('Local demo is ready.', 'green')}`,
			'',
			`  Start app    ${paint('pnpm dev', 'bold')}`,
			`  Local URL    ${paint('http://localhost:4310', 'cyan')}`,
			'',
			...(admin?.email ? [`  Demo login   ${admin.email}`] : []),
			...(admin?.password ? [`  Password     ${admin.password}`] : []),
			'',
			...envelope.warnings.map((warning) => `  ${warning}`),
			'',
		].join('\n');
	}
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
