import { useEffect, useRef } from 'octane';
import { Button, Icon, Tag } from '@coreloom/ui';
import type { ChatEntry, HandoffPlan } from '../server/sessions.ts';
import type { DriverSummary, RoleSummary } from './api.ts';
import type { PreviewSelection } from './state.ts';

export interface ChatPaneProps {
	readonly entries: readonly ChatEntry[];
	readonly delivered: boolean;
	readonly roles: readonly RoleSummary[];
	readonly drivers: readonly DriverSummary[];
	readonly role: string;
	readonly driver: string;
	readonly message: string;
	readonly running: boolean;
	readonly selection: PreviewSelection | null;
	readonly autoContinue: boolean;
	/* Set when the session has never run a turn, so the brief can still start it. */
	readonly pendingBrief: string;
	readonly onStart: () => void;
	readonly onContinue: (handoff: HandoffPlan) => void;
	readonly onApprove: (handoff: HandoffPlan) => void;
	readonly onAutoContinue: (enabled: boolean) => void;
	readonly onRole: (role: string) => void;
	readonly onDriver: (driver: string) => void;
	readonly onMessage: (message: string) => void;
	readonly onSend: () => void;
	readonly onStop: () => void;
	readonly onClearSelection: () => void;
}

function eventLabel(entry: ChatEntry): string {
	const event = entry.event;
	if (!event) return entry.text ?? '';
	switch (event.type) {
		case 'turn.started':
			return `${event.driver} started as ${event.role}`;
		case 'reasoning':
			return event.text.slice(0, 160);
		case 'tool.started':
			return `${event.tool} ${event.detail}`;
		case 'tool.completed':
			return `${event.tool} ${event.detail} ${event.ok ? 'ok' : 'failed'}`;
		case 'file.changed':
			return `${event.change} ${event.path}`;
		case 'error':
			return `${event.code}: ${event.message}`;
		case 'turn.completed':
			return `finished, ${event.usage.totalTokens} tokens`;
		default:
			return event.type;
	}
}

function isError(entry: ChatEntry): boolean {
	return entry.event?.type === 'error';
}

const HANDOFF_LINE = /^handoff\s*:/i;

/* The handoff line is protocol, not conversation: the card below the message
   already says who continues, so the transcript shows the words only. */
function spoken(entry: ChatEntry): string {
	const lines = (entry.text ?? '').split('\n');
	while (lines.length > 0 &&
		lines[lines.length - 1]!.trim() === '') lines.pop();
	const last = lines[lines.length - 1]?.replace(/[`*_]/g, '').trim() ?? '';
	if (entry.kind === 'agent' && HANDOFF_LINE.test(last)) lines.pop();
	while (lines.length > 0 &&
		lines[lines.length - 1]!.trim() === '') lines.pop();
	return lines.join('\n');
}

interface StreamBlock {
	readonly key: number;
	readonly entry: ChatEntry | null;
	readonly events: readonly ChatEntry[] | null;
}

const EVENT_TAIL = 6;

/* One stream in the order it happened: a message, then the tool activity that
   followed it, so the newest thing on screen is the newest thing that happened.
   A long run of tool events keeps only its tail, because the transcript is the
   conversation and the events are its footnotes. */
function streamBlocks(entries: readonly ChatEntry[]): readonly StreamBlock[] {
	const blocks: {
		key: number;
		entry: ChatEntry | null;
		events: ChatEntry[] | null;
	}[] = [];
	for (const entry of entries) {
		const last = blocks[blocks.length - 1];
		if (entry.kind === 'event') {
			if (last?.events) {
				last.events.push(entry);
				continue;
			}
			blocks.push({ key: entry.sequence, entry: null, events: [entry] });
			continue;
		}
		blocks.push({ key: entry.sequence, entry, events: null });
	}
	return blocks.map(
		(block) => ({
			key: block.key,
			entry: block.entry,
			events: block.events ? block.events.slice(-EVENT_TAIL) : null,
		}),
	);
}

function blockKey(block: StreamBlock): number {
	return block.key;
}

function handoffIcon(kind: HandoffPlan['kind']): string {
	if (kind === 'approval') return 'check';
	if (kind === 'blocked') return 'alert';
	if (kind === 'question') return 'help';
	if (kind === 'review') return 'flask';
	return 'play';
}

export function ChatPane(props: ChatPaneProps) @{
	const offered = props.drivers.filter((driver) => driver.offered);
	const stream = streamBlocks(props.entries);
	/* Only the newest handoff can still be acted on. The older ones stay in the
   transcript as a record of who worked and why. */
	const open =
		props.entries.filter((entry) => entry.handoff).at(-1)?.sequence ?? -1;
	const scroller = useRef<HTMLDivElement | null>(null);

	/* The newest message is the one being written, so the transcript follows it. */
	useEffect(() => {
		const node = scroller.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [props.entries.length, props.running]);

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		props.onSend();
	};

	<section class="sandbox__chat">
		<div class="sandbox__scroll" ref={scroller}>
			<div class="chat sandbox__column">
				@for (const block of stream; key blockKey(block)) {
					@if (block.events) {
						<ul class="chat__events">
							@for (const entry of block.events; key entry.sequence) {
								<li
									class={[
										'chat__event',
										isError(entry) && 'chat__event--error',
									]}
								>
									<Icon name={isError(entry) ? 'alert' : 'check'} size={14} />
									{eventLabel(entry)}
								</li>
							}
						</ul>
					} @else if (block.entry!.handoff) {
						<article
							class={[
								'chat__handoff',
								'chat__handoff--' + block.entry!.handoff!.kind,
							]}
						>
							<header class="chat__meta">
								<Icon
									name={handoffIcon(block.entry!.handoff!.kind)}
									size={14}
								/>
								<span>{block.entry!.handoff!.roleName}</span>
								<Tag mono>{block.entry!.handoff!.kind}</Tag>
							</header>
							<p class="chat__text">{block.entry!.text ?? ''}</p>
							@if (block.entry!.sequence === open && !props.running) {
								<div class="ui-form__actions">
									@if (block.entry!.handoff!.kind === 'approval') {
										<Button
											size="sm"
											variant="primary"
											onClick={() => props.onApprove(block.entry!.handoff!)}
										>
											<Icon name="check" size={14} />
											Approve and implement
										</Button>
									} @else if (block.entry!.handoff!.kind === 'continue') {
										<Button
											size="sm"
											variant="primary"
											onClick={() => props.onContinue(block.entry!.handoff!)}
										>
											<Icon name="play" size={14} />
											{'Continue with ' + block.entry!.handoff!.roleName}
										</Button>
									}
								</div>
							}
						</article>
					} @else {
						<article
							class={[
								'chat__turn',
								block.entry!.kind === 'user' && 'chat__turn--user',
							]}
						>
							<header class="chat__meta">
								<span>
									{block.entry!.kind === 'user' ? 'You' : block.entry!.role}
								</span>
							</header>
							<p class="chat__text">{spoken(block.entry!)}</p>
						</article>
					}
				}
				@if (props.pendingBrief && !props.running) {
					<article class="chat__handoff chat__handoff--continue">
						<header class="chat__meta">
							<Icon name="play" size={14} />
							<span>Not started</span>
						</header>
						<p class="chat__text">
							{'This session was created but never ran a turn. Start it from its brief: ' +
								props.pendingBrief}
						</p>
						<div class="ui-form__actions">
							<Button size="sm" variant="primary" onClick={props.onStart}>
								<Icon name="play" size={14} />
								Start the work
							</Button>
						</div>
					</article>
				}
			</div>
		</div>

		<form class="chat__composer" onSubmit={submit}>
			@if (props.selection) {
				<div class="chat__selection">
					<b>{'Selected: ' + props.selection.label}</b>
					<span class="ui-mono">{props.selection.selector}</span>
					<div class="ui-form__actions">
						<Button size="sm" variant="ghost" onClick={props.onClearSelection}>
							Clear selection
						</Button>
					</div>
				</div>
			}
			<textarea
				class="ui-textarea"
				rows={3}
				placeholder="Describe the next change. The selected element is sent with your message."
				value={props.message}
				onInput={(event) => props.onMessage(event.currentTarget.value)}
			></textarea>
			<div class="chat__composer-row">
				<select
					class="chat__picker"
					aria-label="Agent role"
					value={props.role}
					onChange={(event) => props.onRole(event.currentTarget.value)}
				>
					<option value="auto">Auto</option>
					@for (const role of props.roles; key role.id) {
						<option value={role.id}>{role.name}</option>
					}
				</select>
				<select
					class="chat__picker"
					aria-label="Coding agent"
					value={props.driver}
					onChange={(event) => props.onDriver(event.currentTarget.value)}
				>
					@for (const driver of offered; key driver.id) {
						<option value={driver.id}>{driver.label}</option>
					}
				</select>
				<label class="chat__auto">
					<input
						type="checkbox"
						checked={props.autoContinue}
						onInput={(event) => props.onAutoContinue(
							event.currentTarget.checked,
						)}
					/>
					<span>Auto handoff</span>
				</label>
				<span class="sandbox__spacer"></span>
				<span class="ui-help">
					{props.running
						? 'The agent is working.'
						: props.delivered
							? 'This session was delivered. Another turn changes the module again and needs a new delivery.'
							: ''}
				</span>
				@if (props.running) {
					<Button size="sm" variant="danger" onClick={props.onStop}>
						Stop
					</Button>
				} @else {
					<Button
						size="sm"
						variant="primary"
						type="submit"
						disabled={props.message.trim().length === 0}
					>
						<Icon name="play" size={14} />
						Send
					</Button>
				}
			</div>
		</form>
	</section>
}
