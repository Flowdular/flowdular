export interface Profile {
	readonly tenantId: string;
	readonly accountId: string;
	readonly displayName: string;
	readonly updatedAt: number;
}

export interface UpdateProfileInput {
	readonly displayName: string;
}
