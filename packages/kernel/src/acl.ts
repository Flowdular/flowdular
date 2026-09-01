export interface Principal {
	readonly id: string;
	readonly permissions: ReadonlySet<string>;
}

export interface AccessDecision {
	readonly allowed: boolean;
	readonly reason: 'granted' | 'anonymous' | 'missing-permission';
}

export function authorize(
	principal: Principal | null,
	permission: string,
): AccessDecision {
	if (!principal) return { allowed: false, reason: 'anonymous' };
	if (!principal.permissions.has(permission)) {
		return { allowed: false, reason: 'missing-permission' };
	}
	return { allowed: true, reason: 'granted' };
}
