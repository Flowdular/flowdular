import { Button, EmptyState, Icon, Tag } from '@coreloom/ui';
import type { ApiTokenRecord } from '../../domain/types.ts';
import { tokenState } from './state.ts';

export interface ApiTokenListProps {
	readonly tokens: readonly ApiTokenRecord[];
	readonly filtered: boolean;
	readonly busy: boolean;
	readonly onRevoke: (id: string) => void;
}

function tone(state: string): 'success' | 'warning' | 'neutral' {
	if (state === 'active') return 'success';
	return state === 'expired' ? 'warning' : 'neutral';
}

function stamp(value: number | null): string {
	return value === null
		? 'Never'
		: new Date(value).toISOString().slice(0, 16).replace('T', ' ');
}

function identity(token: ApiTokenRecord): string {
	const count = token.scopes.length;
	return token.prefix + '… · ' + count + (count === 1 ? ' scope' : ' scopes');
}

export function ApiTokenList(props: ApiTokenListProps) @{
	const now = Date.now();
	<div>
		@if (props.tokens.length === 0) {
			<EmptyState
				icon="key"
				title={props.filtered ? 'No matching tokens' : 'No API tokens yet'}
			>
				{props.filtered
					? 'No token in this workspace matches the current filter.'
					: 'Issue a token for every machine client that connects without a browser session.'}
			</EmptyState>
		} @else {
			<div class="ui-table-wrap">
				<table class="ui-table" aria-label="API tokens">
					<thead>
						<tr>
							<th>Token</th>
							<th>Status</th>
							<th class="num">Last used</th>
							<th class="ui-table__actions"></th>
						</tr>
					</thead>
					<tbody>
						@for (const token of props.tokens; key token.id) {
							<tr>
								<td>
									<span class="ui-cell">
										<b>{token.label}</b>
										<small class="ui-mono">{identity(token)}</small>
									</span>
								</td>
								<td>
									<span class="ui-table__state">
										<Tag tone={tone(tokenState(token, now))} dot>{tokenState(
											token,
											now,
										)}</Tag>
										<small>
											{token.expiresAt === null
												? 'No expiry'
												: 'Until ' + stamp(token.expiresAt)}
										</small>
									</span>
								</td>
								<td class="num">{stamp(token.lastUsedAt)}</td>
								<td class="ui-table__actions">
									@if (token.revokedAt === null) {
										<Button
											size="sm"
											variant="danger"
											disabled={props.busy}
											onClick={() => props.onRevoke(token.id)}
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
