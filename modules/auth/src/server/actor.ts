import type { Context } from '@octanejs/app-core';
import { userActor, type Actor } from '@coreloom/kernel';
import { principalFromContext } from '../middleware/authentication.ts';

/* The one place a user actor is built, so every module's trail names a user
   the same way. Null means the request carries no principal, and the endpoint
   has already refused it. */
export function actorFromContext(context: Context): Actor | null {
	const principal = principalFromContext(context);
	if (!principal) return null;
	return userActor(principal);
}
