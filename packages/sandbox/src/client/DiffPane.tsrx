import { Button, EmptyState, Tag } from '@coreloom/ui';
import type { DiffLine, FileDiff } from '../server/diff.ts';
import { tokenClass, tokenize } from './highlight.ts';

export interface DiffPaneProps {
	readonly diffs: readonly FileDiff[];
	readonly onAsk: (path: string, snippet: string) => void;
}

function changeTone(change: FileDiff['change']): 'success' | 'info' | 'danger' {
	if (change === 'created') return 'success';
	return change === 'deleted' ? 'danger' : 'info';
}

/* A key may only read the loop variable, so it is derived from the line
   itself: the pair of line numbers is unique inside one hunk. */
function lineKey(line: DiffLine): string {
	return `${line.type}:${line.oldLine ?? '-'}:${line.newLine ?? '-'}`;
}

function sign(type: 'context' | 'add' | 'del'): string {
	if (type === 'add') return '+';
	return type === 'del' ? '-' : ' ';
}

export function DiffPane(props: DiffPaneProps) @{
	<div class="sandbox__scroll">
		@if (props.diffs.length === 0) {
			<EmptyState icon="code" title="No changes yet">
				Files the agent writes in this session appear here as a reviewable diff.
			</EmptyState>
		} @else {
			<div class="diff">
				@for (const diff of props.diffs; key diff.path) {
					<article class="diff__file">
						<header class="diff__file-head">
							<Tag tone={changeTone(diff.change)} dot>{diff.change}</Tag>
							<span class="diff__path">{diff.path}</span>
							<span class="diff__stat diff__stat--add">
								{'+' + diff.additions}
							</span>
							<span class="diff__stat diff__stat--del">
								{'-' + diff.deletions}
							</span>
							<span class="sandbox__spacer"></span>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => props.onAsk(diff.path, '')}
							>
								Ask about this file
							</Button>
						</header>
						@if (diff.truncated) {
							<p class="ui-help" style="padding: 10px 12px">
								{diff.binary
									? 'Binary file, not shown.'
									: 'This file is too large to show inline.'}
							</p>
						} @else {
							@for (const hunk of diff.hunks; key hunk.header) {
								<div class="diff__hunk">
									<div class="diff__hunk-header">{hunk.header}</div>
									@for (const line of hunk.lines; key lineKey(line)) {
										<div class={['diff__line', 'diff__line--' + line.type]}>
											<span class="diff__gutter">
												{line.newLine === null
													? line.oldLine ?? ''
													: line.newLine}
											</span>
											<code class="diff__code">
												{sign(line.type)}
												@for (const token of tokenize(
													line.text,
												); key token.id) {
													<span
														class={tokenClass(token.kind)}
													>{token.text}</span>
												}
											</code>
										</div>
									}
								</div>
							}
						}
					</article>
				}
			</div>
		}
	</div>
}
