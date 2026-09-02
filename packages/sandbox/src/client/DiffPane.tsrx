import { Button, EmptyState, Tag } from '@coreloom/ui';
import type { DiffLine, FileDiff } from '../server/diff.ts';
import { tokenClass, tokenize } from './highlight.ts';
import { useTranslation } from './i18n.ts';

export interface ModuleDiff extends FileDiff {
	readonly module: string;
}

export interface DiffPaneProps {
	readonly diffs: readonly ModuleDiff[];
	/* Show one module only; empty means every module of the session. */
	readonly activeModule: string;
	readonly onAsk: (path: string, snippet: string) => void;
}

interface DiffGroup {
	readonly module: string;
	readonly diffs: readonly ModuleDiff[];
}

function changeTone(change: FileDiff['change']): 'success' | 'info' | 'danger' {
	if (change === 'created') return 'success';
	return change === 'deleted' ? 'danger' : 'info';
}

/* One group per module, in the order the modules appear in the diff, so a
   session that spans modules reads as one list with headers instead of an
   undifferentiated file list. */
function groupByModule(diffs: readonly ModuleDiff[]): readonly DiffGroup[] {
	const groups: { module: string; diffs: ModuleDiff[] }[] = [];
	for (const diff of diffs) {
		const group = groups.find((entry) => entry.module === diff.module);
		if (group) group.diffs.push(diff);
		else groups.push({ module: diff.module, diffs: [diff] });
	}
	return groups;
}

/* A key may only read the loop variable, so it is derived from the line
   itself: the pair of line numbers is unique inside one hunk. */
function lineKey(line: DiffLine): string {
	return `${line.type}:${line.oldLine ?? '-'}:${line.newLine ?? '-'}`;
}

function fileKey(diff: ModuleDiff): string {
	return `${diff.module}/${diff.path}`;
}

function groupKey(group: DiffGroup): string {
	return group.module;
}

function sign(type: 'context' | 'add' | 'del'): string {
	if (type === 'add') return '+';
	return type === 'del' ? '-' : ' ';
}

export function DiffPane(props: DiffPaneProps) @{
	const { t } = useTranslation();
	const visible =
		props.activeModule
			? props.diffs.filter((diff) => diff.module === props.activeModule)
			: props.diffs;
	const groups = groupByModule(visible);

	<div class="sandbox__scroll">
		@if (visible.length === 0) {
			<EmptyState icon="code" title={t('sandbox.diff.empty.title')}>{t(
				'sandbox.diff.empty.hint',
			)}</EmptyState>
		} @else {
			<div class="diff">
				@for (const group of groups; key groupKey(group)) {
					<section class="diff__group">
						@if (groups.length > 1) {
							<header class="diff__module">
								<span class="ui-mono">{'modules/' + group.module}</span>
								<span class="ui-help">
									{group.diffs.length === 1
										? t('sandbox.diff.file.one')
										: t('sandbox.diff.file.other', {
												count: group.diffs.length,
											})}
								</span>
							</header>
						}
						@for (const diff of group.diffs; key fileKey(diff)) {
							<article class="diff__file">
								<header class="diff__file-head">
									<Tag tone={changeTone(diff.change)} dot>{t(
										'sandbox.diff.change.' + diff.change,
									)}</Tag>
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
										onClick={() => props.onAsk(
											'modules/' + diff.module + '/' + diff.path,
											'',
										)}
									>{t('sandbox.diff.ask')}</Button>
								</header>
								@if (diff.truncated) {
									<p class="ui-help" style="padding: 10px 12px">
										{diff.binary
											? t('sandbox.diff.binary')
											: t('sandbox.diff.large')}
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
					</section>
				}
			</div>
		}
	</div>
}
