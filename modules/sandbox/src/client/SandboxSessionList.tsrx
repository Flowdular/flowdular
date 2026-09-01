import { Tag } from '@coreloom/ui';
import type { SandboxSessionRecord } from '../domain/types.ts';
import { sessionTone, timestamp } from './presentation.ts';

export interface SandboxSessionListProps {
	readonly sessions: readonly SandboxSessionRecord[];
}

function origin(session: SandboxSessionRecord): string {
	return session.moduleId + ' · ' + session.driver + ' · ' + session.mode;
}

export function SandboxSessionList(props: SandboxSessionListProps) @{
	<div>
		@if (props.sessions.length === 0) {
			<p class="ui-table__empty">
				No sandbox session has been opened for this workspace.
			</p>
		} @else {
			<div class="ui-table-wrap">
				<table class="ui-table" aria-label="Sandbox sessions">
					<thead>
						<tr>
							<th>Session</th>
							<th>State</th>
							<th class="num">Updated</th>
						</tr>
					</thead>
					<tbody>
						@for (const session of props.sessions; key session.id) {
							<tr>
								<td>
									<span class="ui-cell">
										<b>{session.title}</b>
										<small class="ui-mono">{origin(session)}</small>
									</span>
								</td>
								<td>
									<Tag
										tone={sessionTone(session.state)}
										dot
									>{session.state}</Tag>
								</td>
								<td class="num">{timestamp(session.updatedAt)}</td>
							</tr>
						}
					</tbody>
				</table>
			</div>
		}
	</div>
}
