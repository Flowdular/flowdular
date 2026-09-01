export class AgentHarnessError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'AgentHarnessError';
	}
}
