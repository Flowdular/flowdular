import { Alert, Button, Tag } from '@coreloom/ui';
import type { AgentRunDetail } from '../domain/types.ts';
import { stateTone } from './presentation.ts';

function time(value: number): string {
	return new Intl.DateTimeFormat('en', {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).format(value);
}

export interface RunTimelineProps {
	readonly run: AgentRunDetail;
	/* Present when the viewer may cancel this run while it is queued or running. */
	readonly onCancel?: (() => void) | undefined;
	readonly cancelling?: boolean | undefined;
}

export function RunTimeline(props: RunTimelineProps) @{
	const live = ['queued', 'running'].includes(props.run.status);

	<section class="ui-card">
		<div class="ui-card__head">
			<span class="ui-card__title">
				{props.run.agentName}
				<small>Run detail</small>
			</span>
			<span class="ui-card__actions">
				@if (live && props.onCancel) {
					<Button
						size="sm"
						variant="danger"
						disabled={props.cancelling === true}
						onClick={() => props.onCancel?.()}
					>
						{props.cancelling ? 'Cancelling…' : 'Cancel run'}
					</Button>
				}
				<Tag tone={stateTone(props.run.status)} dot>{props.run.status}</Tag>
			</span>
		</div>
		<div class="run-facts">
			<span>
				<small>Revision</small>
				<b>{'r' + props.run.agentRevision}</b>
			</span>
			<span>
				<small>Trigger</small>
				<b>{props.run.trigger}</b>
			</span>
			<span>
				<small>Attempt</small>
				<b>{props.run.attempt}</b>
			</span>
			<span>
				<small>Provider</small>
				<b>{props.run.provider}</b>
			</span>
		</div>
		<div class="run-block">
			<span>Input</span>
			<pre class="ui-code">{props.run.input}</pre>
		</div>
		@if (props.run.output) {
			<div class="run-block">
				<span>Output</span>
				<pre class="ui-code">{props.run.output}</pre>
			</div>
		}
		@if (props.run.failureMessage) {
			<div class="run-block">
				<Alert>
					<b>{(props.run.failureCode ?? 'RUN_FAILED') + ' '}</b>
					{props.run.failureMessage}
				</Alert>
			</div>
		}
		<div class="run-timeline">
			<span>Execution timeline</span>
			@if (props.run.events.length === 0) {
				<p>The worker has not emitted an event yet.</p>
			} @else {
				@for (const event of props.run.events; key event.sequence) {
					<div class="run-event">
						<span>{String(event.sequence).padStart(2, '0')}</span>
						<div class="ui-cell">
							<b>{event.type}</b>
							<small>{event.message}</small>
						</div>
						<time>{time(event.timestamp)}</time>
					</div>
				}
			}
		</div>
	</section>
}
