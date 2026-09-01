import { Button, Icon, Tag } from '@coreloom/ui';
import type { SandboxAccessGrant } from '../domain/types.ts';
import {
	capabilityLabel,
	grantState,
	grantTone,
	timestamp,
} from './presentation.ts';

export interface SandboxGrantListProps {
	readonly grants: readonly SandboxAccessGrant[];
	readonly busy: boolean;
	readonly onRevoke: (accountId: string) => void;
}

function capabilities(grant: SandboxAccessGrant): string {
	return grant.capabilities.map(capabilityLabel).join(' · ');
}

export function SandboxGrantList(props: SandboxGrantListProps) @{
	const now = Date.now();
	<div>
		@if (props.grants.length === 0) {
			<p class="ui-table__empty">
				No account has sandbox access in this workspace yet.
			</p>
		} @else {
			<div class="ui-table-wrap">
				<table class="ui-table" aria-label="Sandbox access grants">
					<thead>
						<tr>
							<th>Account</th>
							<th>Capabilities</th>
							<th>Status</th>
							<th class="ui-table__actions"></th>
						</tr>
					</thead>
					<tbody>
						@for (const grant of props.grants; key grant.id) {
							<tr>
								<td>
									<span class="ui-cell">
										<b>{grant.displayName}</b>
										<small class="ui-mono">{grant.email}</small>
									</span>
								</td>
								<td class="ui-cell__muted">{capabilities(grant)}</td>
								<td>
									<span class="ui-table__state">
										<Tag
											tone={grantTone(grantState(grant, now))}
											dot
										>{grantState(grant, now)}</Tag>
										<small>
											{grant.expiresAt === null
												? 'No expiry'
												: 'Until ' + timestamp(grant.expiresAt)}
										</small>
									</span>
								</td>
								<td class="ui-table__actions">
									@if (grant.revokedAt === null) {
										<Button
											size="sm"
											variant="danger"
											disabled={props.busy}
											onClick={() => props.onRevoke(grant.accountId)}
										>
											<Icon name="x" size={14} />
											Revoke
										</Button>
									}
								</td>
							</tr>
						}
					</tbody>
				</table>
			</div>
		}
	</div>
}
