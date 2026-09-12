export class AuthServiceError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(
		code: string,
		message: string,
		status: number,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'AuthServiceError';
		this.code = code;
		this.status = status;
	}
}
