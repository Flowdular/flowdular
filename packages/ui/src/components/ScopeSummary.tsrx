export interface ScopeSummaryProps {
	/** Scopes shaped `module.entity.action`; shorter ids still group by module. */
	scopes: readonly string[];
	/** Display name per module id; the id is capitalized when absent. */
	labels?: Readonly<Record<string, string>> | undefined;
}

interface ScopeEntity {
	readonly name: string;
	readonly actions: readonly string[];
	readonly scopes: readonly string[];
}

interface ScopeRow {
	readonly module: string;
	readonly entities: readonly ScopeEntity[];
}

/* One pass over the scopes; modules and entities keep their first-seen order
   so the summary matches the CheckGrid that edits the same set. */
export function summarizeScopes(
	scopes: readonly string[],
): readonly ScopeRow[] {
	const modules = new Map<
		string,
		Map<string, { actions: string[]; scopes: string[] }>
	>();
	for (const scope of scopes) {
		const parts = scope.split('.');
		const module = parts[0] ?? scope;
		const action =
			parts.length > 1 ? parts[parts.length - 1]! : '';
		const entity = parts.slice(1, -1).join('.');
		const entities = modules.get(module) ?? new Map();
		const entry = entities.get(entity) ?? { actions: [], scopes: [] };
		if (action !== '' && !entry.actions.includes(action)) {
			entry.actions.push(action);
		}
		entry.scopes.push(scope);
		entities.set(entity, entry);
		modules.set(module, entities);
	}
	return [...modules].map(
		([module, entities]) => ({
			module,
			entities: [...entities].map(([name, entry]) => ({ name, ...entry })),
		}),
	);
}

function moduleLabel(
	module: string,
	labels: Readonly<Record<string, string>> | undefined,
): string {
	return labels?.[module] ?? module.charAt(0).toUpperCase() + module.slice(1);
}

export function ScopeSummary(props: ScopeSummaryProps) @{
	<dl class="ui-scopes">
		@for (const row of summarizeScopes(props.scopes); key row.module) {
			<div class="ui-scopes__row">
				<dt>{moduleLabel(row.module, props.labels)}</dt>
				<dd>
					@for (const entity of row.entities; key entity.name) {
						<span class="ui-scopes__chip" title={entity.scopes.join(', ')}>
							@if (entity.name) {
								<b>{entity.name}</b>
							}
							{entity.actions.join(', ')}
						</span>
					}
				</dd>
			</div>
		}
	</dl>
}
