import { Icon } from '@flowdular/ui';
import { useTranslation } from './i18n.ts';
import {
	shortToolDetail,
	toolAction,
	type TranscriptRow,
} from './transcript.ts';

export function ToolEvent(props: {
	readonly row: TranscriptRow;
	readonly running: boolean;
}) @{
	const { t } = useTranslation();
	const event = props.row.entry.event!;
	const original = props.row.started?.event ?? event;
	if (
		event.type !== 'tool.started' && event.type !== 'tool.completed' ||
			original.type !== 'tool.started' && original.type !== 'tool.completed'
	) return;
	const status =
		event.type === 'tool.completed'
			? event.ok
				? 'done'
				: 'failed'
			: props.row.pending && props.running
				? 'running'
				: 'unknown';
	const detail = original.detail || event.detail;
	const action = toolAction(original.tool);
	const target =
		action === 'command' ? detail : shortToolDetail(detail);
	const duration =
		props.row.started
			? (Math.max(0, props.row.entry.at - props.row.started.at) / 1000).toFixed(
					1,
				)
			: null;
	<details class={['chat-tool', 'chat-tool--' + status]} data-status={status}>
		<summary class="chat-tool__summary">
			<Icon
				name={status === 'running'
					? 'refresh'
					: status === 'done'
						? 'check'
						: 'alert'}
				size={14}
			/>
			<span class="chat-tool__action">{t(
				'sandbox.chat.tool.action.' + action,
			)}</span>
			<span class="chat-tool__target" title={detail}>
				{target || original.tool}
			</span>
			<span class="chat-tool__status">{t(
				'sandbox.chat.tool.status.' + status,
			)}</span>
			@if (duration !== null) {
				<span class="chat-tool__duration">{t('sandbox.chat.tool.duration', {
					seconds: duration,
				})}</span>
			}
			<Icon name="chevron-down" size={14} />
		</summary>
		<dl class="chat-tool__details">
			<dt>{t('sandbox.chat.tool.name')}</dt>
			<dd>{original.tool}</dd>
			<dt>{t('sandbox.chat.tool.detail')}</dt>
			<dd>{detail || t('sandbox.chat.tool.noDetail')}</dd>
			@if (event.detail && event.detail !== detail) {
				<>
					<dt>{t('sandbox.chat.tool.result')}</dt>
					<dd>{event.detail}</dd>
				</>
			}
		</dl>
	</details>
}
