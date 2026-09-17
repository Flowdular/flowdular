import { t } from '@flowdular/client/i18n';
import type { TenantRole } from '@flowdular/module-auth';

type NamedRole = Pick<TenantRole, 'builtin' | 'key' | 'name' | 'description'>;

function builtinCopy(role: NamedRole, family: string, stored: string): string {
	if (!role.builtin) return stored;
	const key = `users.roles.${family}.${role.key}`;
	const label = t(key);
	return label === key ? stored : label;
}

/* Built-in roles are seeded with English names under stable keys, so the
   reader's locale names them; a custom role keeps what its author typed. */
export function roleName(role: NamedRole): string {
	return builtinCopy(role, 'builtinName', role.name);
}

export function roleDescription(role: NamedRole): string {
	return builtinCopy(role, 'builtinDescription', role.description);
}
