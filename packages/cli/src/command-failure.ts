import { failure, type CommandEnvelope } from '@flowdular/cli-protocol';
import { DatabaseError, DatabaseMigrationError } from '@flowdular/database';
import {
	LocalDatabaseLockedError,
	LocalDatabaseUnreadableError,
} from '@flowdular/database-pglite';
import {
	KeyringError,
	RegistryError,
	VariableResolutionError,
} from '@flowdular/kernel';
import { LegacyLocalStateError } from '@flowdular/kernel/legacy-local-state';
import { UnsafeLocalStatePathError } from '@flowdular/kernel/runtime-config';
import { ModuleDistributionError } from './module-artifact.ts';

/* The platform's stable code form. Anything else a driver or a bug put on
   `code` stays out of the envelope. */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/* The coded classes without a status of the kernel, database and CLI packages
   the runner loads. The published CLI bundles its own copies, so there one
   thrown from a module's SDK copy falls back to COMMAND_FAILED. */
const PLATFORM_ERRORS = [
	ModuleDistributionError,
	RegistryError,
	KeyringError,
	LegacyLocalStateError,
	UnsafeLocalStatePathError,
	VariableResolutionError,
	DatabaseMigrationError,
	DatabaseError,
	LocalDatabaseLockedError,
	LocalDatabaseUnreadableError,
];

/* A module refuses with its own class, which the runner cannot import. Every
   module service error carries a code and an HTTP status, the pair its
   endpoints already show a caller. Node.js, driver and library errors carry
   no status, so they stay COMMAND_FAILED. */
function isModuleRefusal(error: Error): boolean {
	return typeof (error as { status?: unknown }).status === 'number';
}

/** Only the code and the message leave: never the stack, cause or fields. */
export function commandFailure(error: unknown): CommandEnvelope<never> {
	if (!(error instanceof Error))
		return failure('COMMAND_FAILED', String(error));
	const code = (error as { code?: unknown }).code;
	const known =
		PLATFORM_ERRORS.some((type) => error instanceof type) ||
		isModuleRefusal(error);
	return failure(
		known && typeof code === 'string' && STABLE_CODE.test(code)
			? code
			: 'COMMAND_FAILED',
		error.message,
	);
}
