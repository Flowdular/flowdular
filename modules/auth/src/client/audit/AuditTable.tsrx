import { Tag } from '@coreloom/ui';
import type { AuditEvent } from '../../domain/types.ts';

export interface AuditTableProps {
	readonly events: readonly AuditEvent[];
}

function stamp(value: number): string {
	return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
}

function tone(action: string): 'danger' | 'warning' | 'neutral' | 'info' {
	if (action.includes('failed') || action.includes('locked')) return 'danger';
	if (
		action.includes('removed') || action.includes('deleted')
	) return 'warning';
	if (action.includes('sign-in') || action.includes('sign-out')) return 'info';
	return 'neutral';
}

function details(event: AuditEvent): string {
	const entries = Object.entries(event.metadata);
	if (entries.length === 0) return '';
	return entries.map(
		([key, value]) => `${key}: ${
			Array.isArray(value) ? value.length + ' items' : String(value)
		}`,
	).join(' · ');
}

export function AuditTable(props: AuditTableProps) @{
	<div class="ui-table-wrap">
		<table class="ui-table" aria-label="Audit trail">
			<thead>
				<tr>
					<th>When</th>
					<th>Action</th>
					<th>Actor</th>
					<th>Subject</th>
				</tr>
			</thead>
			<tbody>
				@for (const event of props.events; key event.id) {
					<tr>
						<td class="ui-mono">{stamp(event.occurredAt)}</td>
						<td>
							<span class="ui-cell">
								<Tag tone={tone(event.action)} mono>{event.action}</Tag>
								@if (details(event)) {
									<small>{details(event)}</small>
								}
							</span>
						</td>
						<td>{event.actorLabel}</td>
						<td>
							<span class="ui-cell">
								<span>{event.subjectType}</span>
								<small class="ui-mono">{event.subjectId}</small>
							</span>
						</td>
					</tr>
				}
			</tbody>
		</table>
	</div>
}
