export interface TaskPacket {
	readonly schemaVersion: 1;
	readonly taskId: string;
	readonly capability: string;
	readonly blueprint: string;
	readonly spec: string;
	readonly specStatus: 'approved';
	readonly allowedPaths: readonly string[];
	readonly steps: readonly string[];
	readonly gates: readonly string[];
}

export interface TaskPacketIssue {
	readonly code: string;
	readonly message: string;
}

const broadPaths = new Set([
	'*',
	'**',
	'./**',
	'platform/**',
	'modules/**',
	'packages/**',
	'infra/**',
	'docs/**',
	'specs/**',
	'.ai/**',
	'.github/**',
	'.',
]);

export function validateTaskPacket(
	packet: TaskPacket,
): readonly TaskPacketIssue[] {
	const issues: TaskPacketIssue[] = [];
	if (packet.schemaVersion !== 1) {
		issues.push({
			code: 'TASK_SCHEMA_VERSION',
			message: 'Only task packet schemaVersion 1 is supported.',
		});
	}
	if (packet.specStatus !== 'approved') {
		issues.push({
			code: 'SPEC_NOT_APPROVED',
			message: 'Implementation requires an approved spec.',
		});
	}
	if (!/^[a-z][a-z0-9-]+@[0-9]+\.[0-9]+\.[0-9]+$/.test(packet.blueprint)) {
		issues.push({
			code: 'BLUEPRINT_NOT_PINNED',
			message: 'Blueprint id must include an exact semantic version.',
		});
	}
	if (
		packet.allowedPaths.length === 0 ||
		packet.allowedPaths.some((path) => broadPaths.has(path))
	) {
		issues.push({
			code: 'PATH_SCOPE_TOO_BROAD',
			message: 'Task paths must be non-empty and module-bounded.',
		});
	}
	if (packet.steps.length === 0) {
		issues.push({
			code: 'STEPS_MISSING',
			message: 'A low-cost executor needs explicit ordered steps.',
		});
	}
	if (packet.gates.length === 0) {
		issues.push({
			code: 'GATES_MISSING',
			message: 'A task packet must declare verification gates.',
		});
	}
	return issues;
}

export function assertTaskPacket(packet: TaskPacket): void {
	const issues = validateTaskPacket(packet);
	if (issues.length > 0) {
		throw new Error(
			issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n'),
		);
	}
}
