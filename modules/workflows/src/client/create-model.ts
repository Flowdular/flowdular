/** Matches the tenant-local key contract enforced by WorkflowsService. */
export const WORKFLOW_KEY_PATTERN = '[a-z][a-z0-9\\-]{2,119}';

export function suggestedWorkflowKey(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replaceAll('ł', 'l')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^[^a-z]+/, '')
		.replace(/-+$/, '')
		.slice(0, 120);
}
