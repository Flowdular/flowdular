import { useMemo } from 'octane';
import {
	parseMarkdown,
	type MarkdownBlock,
	type MarkdownInline,
	type TableAlign,
} from './markdown.ts';

function alignStyle(align: TableAlign | undefined): string | null {
	return align ? 'text-align:' + align : null;
}

function Inlines(props: { readonly nodes: readonly MarkdownInline[] }) @{
	@for (const [index, node] of props.nodes.entries(); key index) {
		@if (node.kind === 'text') {
			<>
				{node.text}
			</>
		} @else if (node.kind === 'code') {
			<code>{node.text}</code>
		} @else if (node.kind === 'strong') {
			<strong>
				<Inlines nodes={node.children} />
			</strong>
		} @else if (node.kind === 'emphasis') {
			<em>
				<Inlines nodes={node.children} />
			</em>
		} @else {
			<a href={node.href} target="_blank" rel="noopener noreferrer nofollow">
				<Inlines nodes={node.children} />
			</a>
		};
	}
}

function Blocks(props: { readonly blocks: readonly MarkdownBlock[] }) @{
	@for (const [index, block] of props.blocks.entries(); key index) {
		@if (block.kind === 'paragraph') {
			<p>
				<Inlines nodes={block.inlines} />
			</p>
		} @else if (block.kind === 'heading') {
			@if (block.level <= 2) {
				<h4>
					<Inlines nodes={block.inlines} />
				</h4>
			} @else {
				<h5>
					<Inlines nodes={block.inlines} />
				</h5>
			}
		} @else if (block.kind === 'list') {
			@if (block.ordered) {
				<ol start={block.start}>
					@for (const [item, blocks] of block.items.entries(); key item) {
						<li>
							<Blocks blocks={blocks} />
						</li>
					}
				</ol>
			} @else {
				<ul>
					@for (const [item, blocks] of block.items.entries(); key item) {
						<li>
							<Blocks blocks={blocks} />
						</li>
					}
				</ul>
			}
		} @else if (block.kind === 'code') {
			<pre class="ui-code">
				<code>{block.text}</code>
			</pre>
		} @else if (block.kind === 'quote') {
			<blockquote>
				<Blocks blocks={block.blocks} />
			</blockquote>
		} @else if (block.kind === 'table') {
			<div class="ui-table-wrap">
				<table>
					<thead>
						<tr>
							@for (const [column, cell] of block.head.entries(); key column) {
								<th style={alignStyle(block.align[column])}>
									<Inlines nodes={cell} />
								</th>
							}
						</tr>
					</thead>
					<tbody>
						@for (const [row, cells] of block.rows.entries(); key row) {
							<tr>
								@for (const [column, cell] of cells.entries(); key column) {
									<td style={alignStyle(block.align[column])}>
										<Inlines nodes={cell} />
									</td>
								}
							</tr>
						}
					</tbody>
				</table>
			</div>
		} @else {
			<hr />
		};
	}
}

/* An agent message as formatted text. Every node is an element or a text
   node built from the parsed tree, never markup from the message. */
export function Markdown(props: { readonly text: string }) @{
	const blocks = useMemo(() => parseMarkdown(props.text), [props.text]);
	<div class="chat__markdown">
		<Blocks blocks={blocks} />
	</div>
}
