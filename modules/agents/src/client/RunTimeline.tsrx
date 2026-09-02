import { useMemo } from 'octane';
import { t } from '@coreloom/client';
import { Alert, Button, Icon, Tag } from '@coreloom/ui';
import { useValue } from 'segment-state';
import type { AgentRunTimeline } from '../domain/types.ts';
import type {
	RunTimelineEntry,
	RunTimelineEvent,
	RunTimelineOutput,
} from '../domain/run-timeline.ts';
import {
	clockLabel,
	countLabel,
	stateTone,
	triggerLabel,
} from './presentation.ts';
import { createRunTimelineState } from './state.ts';

const TOOL_STATES: Readonly<Record<string, string>> = {
	'tool.started': 'started',
	'tool.completed': 'completed',
	'tool.failed': 'failed',
	'tool.denied': 'denied',
};

function toolState(entry: RunTimelineEvent): string {
	return TOOL_STATES[entry.type] ?? '';
}

function toolName(entry: RunTimelineEvent): string {
	const tool = entry.metadata['tool'];
	return typeof tool === 'string' ? tool : entry.type;
}

function pairs(
	entry: RunTimelineEvent,
): readonly { readonly key: string; readonly value: string }[] {
	return Object.entries(entry.metadata).map(
		([key, value]) => ({
			key,
			value: String(value),
		}),
	);
}

function span(entry: RunTimelineOutput): string {
	const from = clockLabel(entry.startedAt);
	const to = clockLabel(entry.endedAt);
	return from === to ? from : t('agents.timeline.timeRange', { from, to });
}

function folded(entry: RunTimelineOutput): string {
	return t('agents.timeline.outputSummary', {
		deltas: countLabel(entry.deltas),
		characters: countLabel(entry.characters),
	});
}

export interface RunTimelineProps {
	readonly run: AgentRunTimeline;
	readonly onCancel?: (() => void) | undefined;
	readonly cancelling?: boolean | undefined;
}

/* The persisted trail of one run. A folded answer reads as prose; a tool call
   stays one line and opens on click; a refusal or failure carries the danger
   surface so it cannot be scrolled past. */
export function RunTimeline(props: RunTimelineProps) @{
	const local = useMemo(() => createRunTimelineState(), []);
	const [expanded, setExpanded] = useValue(local.state.expanded);
	const live = ['queued', 'running'].includes(props.run.status);

	const toggle = (sequence: number) => {
		setExpanded(
			expanded.includes(sequence)
				? expanded.filter((value) => value !== sequence)
				: [...expanded, sequence],
		);
	};

	<aside class="ui-card run-detail">
		<div class="ui-card__head">
			<span class="ui-card__title">
				{props.run.agentName}
				<small>{t('agents.runs.revision', {
					revision: props.run.agentRevision,
				})}</small>
			</span>
			<div class="ui-card__actions">
				@if (live && props.onCancel) {
					<Button
						size="sm"
						variant="danger"
						disabled={props.cancelling === true}
						onClick={() => props.onCancel?.()}
					>
						{props.cancelling
							? t('agents.timeline.cancelling')
							: t('agents.timeline.cancel')}
					</Button>
				}
				<Tag tone={stateTone(props.run.status)} dot>{t(
					'agents.runStatus.' + props.run.status,
				)}</Tag>
			</div>
		</div>
		<dl class="run-facts">
			<div>
				<dt>{t('agents.runs.column.trigger')}</dt>
				<dd>{triggerLabel(props.run.trigger)}</dd>
			</div>
			<div>
				<dt>{t('agents.timeline.provider')}</dt>
				<dd class="ui-mono">{props.run.provider}</dd>
			</div>
			<div>
				<dt>{t('agents.definitions.form.model')}</dt>
				<dd class="ui-mono">{props.run.model}</dd>
			</div>
			<div>
				<dt>{t('agents.timeline.attempt')}</dt>
				<dd>{props.run.attempt}</dd>
			</div>
		</dl>
		<section class="run-prompt">
			<span>{t('agents.timeline.input')}</span>
			<pre>{props.run.input}</pre>
		</section>
		@if (props.run.failureMessage) {
			<div class="run-failure">
				<Alert>
					<b>{(props.run.failureCode ?? 'RUN_FAILED') + ' '}</b>
					{props.run.failureMessage}
				</Alert>
			</div>
		}
		<section class="run-trail" aria-label={t('agents.timeline.trail')}>
			<header class="run-trail__head">
				<span>{t('agents.timeline.trail')}</span>
				<small>{t('agents.timeline.entries', {
					count: countLabel(props.run.timeline.length),
				})}</small>
			</header>
			@if (props.run.timeline.length === 0) {
				<p class="run-trail__idle">{t('agents.timeline.empty')}</p>
			} @else {
				@for (const entry of props.run.timeline; key entry.sequence) {
					@if (entry.kind === 'output') {
						<article class="run-answer">
							<header class="run-answer__head">
								<span class="run-answer__label">{t(
									'agents.timeline.answer',
								)}</span>
								<span class="run-answer__meta">{folded(entry)}</span>
								<time class="run-answer__time">{span(entry)}</time>
							</header>
							<pre class="run-answer__text">{entry.text}</pre>
							@if (entry.omittedCharacters > 0) {
								<p class="run-answer__more">{t('agents.timeline.omitted', {
									count: countLabel(entry.omittedCharacters),
								})}</p>
							}
						</article>
					} @else if (toolState(entry)) {
						<div
							class={[
								'run-entry',
								'run-entry--tool',
								['tool.failed', 'tool.denied'].includes(entry.type) &&
									'run-entry--danger',
							]}
						>
							<button
								class="run-entry__toggle"
								type="button"
								aria-expanded={expanded.includes(entry.sequence)}
								onClick={() => toggle(entry.sequence)}
							>
								<Icon name="chevron-down" size={14} />
								<b class="ui-mono">{toolName(entry)}</b>
								<span class="run-entry__state">{t(
									'agents.timeline.tool.' + toolState(entry),
								)}</span>
								<time class="run-entry__time">{clockLabel(
									entry.timestamp,
								)}</time>
							</button>
							@if (expanded.includes(entry.sequence)) {
								<dl class="run-entry__detail">
									<dt>{t('agents.timeline.message')}</dt>
									<dd>{entry.message}</dd>
									@for (const pair of pairs(entry); key pair.key) {
										<>
											<dt>{pair.key}</dt>
											<dd class="ui-mono">{pair.value}</dd>
										</>
									}
								</dl>
							}
						</div>
					} @else {
						<div class="run-entry">
							<span class="run-entry__dot" aria-hidden="true"></span>
							<span class="run-entry__text">{entry.message}</span>
							<time class="run-entry__time">{clockLabel(entry.timestamp)}</time>
						</div>
					};
				}
			}
		</section>
	</aside>
}
