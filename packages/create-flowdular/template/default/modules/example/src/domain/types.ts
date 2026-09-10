export interface Note {
	readonly tenantId: string;
	readonly id: string;
	readonly title: string;
	readonly body: string;
	readonly createdAt: number;
}

export interface CreateNoteInput {
	readonly title: string;
	readonly body: string;
}
