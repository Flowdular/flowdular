export class RegistryError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = 'RegistryError';
		this.code = code;
	}
}
