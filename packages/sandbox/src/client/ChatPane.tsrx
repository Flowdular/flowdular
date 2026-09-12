import { useEffect, useRef, useState } from 'octane';
import { Button, Icon, Tag } from '@flowdular/ui';
import type {
	ChatEntry,
	HandoffPlan,
	SessionAttachment,
	SessionCheckpoint,
	SessionModule,
} from '../server/sessions.ts';
import {
	attachmentUrl,
	deleteAttachment,
	loadSession,
	restoreCheckpoint,
	uploadAttachment,
	type DriverSummary,
	type ModuleSpecReview,
	type RoleSummary,
	type SubmittedAnswer,
} from './api.ts';
import {
	readQuestions,
	type PendingQuestion,
	type PendingQuestions,
} from '../server/questions.ts';
import { PendingQuestionsCard } from './PendingQuestionsCard.tsrx';
import { ToolEvent } from './ToolEvent.tsrx';
import { transcriptRows, type TranscriptRow } from './transcript.ts';
import { TurnActivity } from './TurnActivity.tsrx';
import { ComposerSettings } from './ComposerSettings.tsrx';
import { ApprovalHandoff } from './ApprovalHandoff.tsrx';
import { ATTACH_ACCEPT, attachmentKind, formatBytes } from './attachments.ts';
import {
	sessionIdFromUrl,
	type PendingAttachment,
	type PreviewSelection,
} from './state.ts';
import { t, useTranslation } from './i18n.ts';
import { roleLabel, handoffLabel } from './session-labels.ts';

export interface ChatPaneProps {
	readonly entries: readonly ChatEntry[];
	readonly delivered: boolean;
	/* Archived and delivered both close the session to work, so a pending
   decision form is read-only under either. */
	readonly archived: boolean;
	readonly roles: readonly RoleSummary[];
	readonly drivers: readonly DriverSummary[];
	readonly modules: readonly SessionModule[];
	/* One specification review per module, in session order. */
	readonly specs: readonly ModuleSpecReview[];
	readonly role: string;
	/* The module the next turn targets; empty lets the sandbox decide. */
	readonly module: string;
	readonly driver: string;
	readonly message: string;
	readonly running: boolean;
	readonly busy?: boolean;
	readonly selection: PreviewSelection | null;
	readonly autoContinue: boolean;
	/* The decisions the specialist that asked is still waiting for. */
	readonly pendingQuestions: PendingQuestions | null;
	readonly answersError: string;
	/* Set when the session has never run a turn, so the brief can still start it. */
	readonly pendingBrief: string;
	readonly onStart: () => void;
	readonly onContinue: (handoff: HandoffPlan) => void;
	readonly onApprove: (handoff: HandoffPlan) => void;
	readonly onRequestChanges: (module: string, comment: string) => void;
	readonly onEditSpec: (module: string) => void;
	readonly onAutoContinue: (enabled: boolean) => void;
	readonly onRole: (role: string) => void;
	readonly onModule: (module: string) => void;
	readonly onDriver: (driver: string) => void;
	readonly onMessage: (message: string) => void;
	readonly onSend: (freshContext?: boolean) => void;
	readonly onAnswers: (answers: readonly SubmittedAnswer[], message: string) => void;
	readonly onStop: () => void;
	readonly onClearSelection: () => void;
}

function eventLabel(entry: ChatEntry): string {
	const event = entry.event;
	if (!event) return entry.text ?? '';
	switch (event.type) {
		case 'turn.started':
			return t('sandbox.chat.event.started', {
				driver: event.driver,
				role: roleLabel(event.role),
			});
		case 'activity':
			return t('sandbox.chat.activity.' + event.phase);
		case 'reasoning':
			return event.text.slice(0, 160);
		case 'tool.started':
			return `${event.tool} ${event.detail}`;
		case 'tool.completed':
			return `${event.tool} ${event.detail} ${
				event.ok ? t('sandbox.chat.event.ok') : t('sandbox.chat.event.failed')
			}`;
		case 'file.changed':
			return `${event.change} ${event.path}`;
		case 'error':
			return `${event.code}: ${event.message}`;
		case 'turn.completed':
			return t('sandbox.chat.event.finished', {
				count: event.usage.totalTokens,
			});
		default:
			return event.type;
	}
}

function isError(entry: ChatEntry): boolean {
	return entry.event?.type === 'error';
}

const HANDOFF_LINE = /^handoff\s*:/i;

/* The handoff line and the questions block are protocol, not conversation: the
   cards below the message already say who continues and what is being asked,
   so the transcript shows the words only. */
function spoken(entry: ChatEntry, text: string): string {
	const lines = text.split('\n');
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
	readonly events: readonly TranscriptRow[] | null;
	/* The message as words, with the protocol lines taken out. */
	readonly speech: string;
	/* The decisions this message asked for, read once so the transcript can
   list them instead of showing the operator raw JSON. */
	readonly questions: readonly PendingQuestion[];
}

/* One stream in the order it happened: a message, then the tool activity that
   followed it, so the newest thing on screen is the newest thing that happened.
   Keep the complete history; paired calls retain their original position. */
function streamBlocks(entries: readonly ChatEntry[]): readonly StreamBlock[] {
	const blocks: {
		key: number;
		entry: ChatEntry | null;
		events: TranscriptRow[] | null;
	}[] = [];
	for (const row of transcriptRows(entries)) {
		const entry = row.entry;
		if (entry.event?.type === 'reasoning' && !entry.event.text.trim()) continue;
		const last = blocks[blocks.length - 1];
		if (entry.kind === 'event') {
			if (last?.events) {
				if (
					entry.event?.type === 'activity' &&
						last.events.at(-1)?.entry.event?.type === 'activity'
				) {
					last.events[last.events.length - 1] = row;
				} else last.events.push(row);
				continue;
			}
			blocks.push({ key: entry.sequence, entry: null, events: [row] });
			continue;
		}
		blocks.push({ key: entry.sequence, entry, events: null });
	}
	return blocks.map((block) => {
		const reading =
			block.entry?.kind === 'agent'
				? readQuestions(block.entry.text ?? '')
				: null;
		return {
			key: block.key,
			entry: block.entry,
			events: block.events,
			speech: block.entry
				? spoken(
						block.entry,
						reading?.kind === 'valid'
							? reading.remainder
							: block.entry.text ?? '',
					)
				: '',
			questions: reading?.kind === 'valid' ? reading.questions : [],
		};
	});
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
	const { t } = useTranslation();
	const offered = props.drivers.filter((driver) => driver.offered);
	const stream = streamBlocks(props.entries);
	const isActive = (entry: ChatEntry) =>
		props.running && entry.sequence === props.entries.at(-1)?.sequence &&
			(entry.event?.type === 'activity' ||
				entry.event?.type === 'tool.started');
	/* Which module an entry belongs to only matters once a session has several;
   with one module the transcript stays as quiet as it was. */
	const moduleLabel = (entry: ChatEntry) => props.modules.length > 1 &&
	entry.module
		? <span class="ui-mono chat__module">{entry.module}</span>
		: null;
	/* Only the newest handoff can still be acted on. The older ones stay in the
   transcript as a record of who worked and why. */
	const open =
		props.entries.filter((entry) => entry.handoff).at(-1)?.sequence ?? -1;
	const scroller = useRef<HTMLDivElement | null>(null);
	const followLatest = useRef(true);
	const attachInput = useRef<HTMLInputElement | null>(null);
	/* The composer manages its own attachments: App owns the transcript, but the
   session id from the URL is enough to upload, list and remove them here. */
	const sessionId =
		typeof window === 'undefined'
			? ''
			: sessionIdFromUrl(window.location.pathname);
	const [attachments, setAttachments] = useState<
		readonly SessionAttachment[]
	>([]);
	const [pending, setPending] = useState<readonly PendingAttachment[]>([]);
	const [attachError, setAttachError] = useState('');
	const [checkpoints, setCheckpoints] = useState<
		readonly SessionCheckpoint[]
	>([]);
	const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
	const [restoring, setRestoring] = useState(false);
	const [restoreError, setRestoreError] = useState('');
	const firstKey =
		stream.length > 0 ? stream[0]!.key : -1;
	/* A block is a restore point when a checkpoint shares its sequence; the start
   checkpoint (sequence 0) has no block of its own, so it rides the first. */
	const checkpointFor = (key: number): SessionCheckpoint | undefined =>
		checkpoints.find((entry) => entry.sequence === key) ??
			(key === firstKey
				? checkpoints.find((entry) => entry.sequence === 0)
				: undefined);

	/* Follow new events only while the operator is already at the bottom. */
	useEffect(() => {
		followLatest.current = true;
	}, [sessionId]);
	useEffect(() => {
		const node = scroller.current;
		if (node && followLatest.current) node.scrollTop = node.scrollHeight;
	}, [props.entries.length, props.running, sessionId]);

	/* Seed the strip from the open session, and reset it when the session
   changes so one session's attachments never show under another. */
	useEffect(() => {
		if (!sessionId) {
			setAttachments([]);
			setPending([]);
			return;
		}
		let cancelled = false;
		void loadSession(sessionId).then((loaded) => {
			if (!cancelled) setAttachments(loaded.session.attachments ?? []);
		}).catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [sessionId, props.running]);

	/* Restore points refresh when a turn ends, so the checkpoint a turn just wrote
   becomes offerable without leaving the session. */
	useEffect(() => {
		if (!sessionId) {
			setCheckpoints([]);
			return;
		}
		let cancelled = false;
		void loadSession(sessionId).then((loaded) => {
			if (!cancelled) setCheckpoints(loaded.session.checkpoints ?? []);
		}).catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [sessionId, props.running]);

	const uploadFiles = (files: readonly File[]) => {
		if (!sessionId || files.length === 0) return;
		setAttachError('');
		for (const file of files) {
			const key = `${file.name}-${Date.now()}-${Math.random().toString(
				36,
			).slice(2, 8)}`;
			setPending(
				(current) => [
					...current,
					{
						key,
						name: file.name,
						kind: attachmentKind(file),
						status: 'uploading',
					},
				],
			);
			void uploadAttachment(sessionId, file).then((result) => {
				setAttachments((current) => [...current, result.attachment]);
				setPending((current) => current.filter((item) => item.key !== key));
			}).catch((error: unknown) => {
				const reason =
					error instanceof Error
						? error.message
						: t('sandbox.attachments.uploadFailed');
				setPending(
					(current) => current.map(
						(item) => item.key === key
							? { ...item, status: 'error', error: reason }
							: item,
					),
				);
			});
		}
	};

	const onPaste = (event: ClipboardEvent) => {
		const files = event.clipboardData?.files;
		if (!files || files.length === 0) return;
		const images = Array.from(files).filter(
			(file) => file.type.startsWith('image/'),
		);
		if (images.length === 0) return;
		event.preventDefault();
		uploadFiles(images);
	};

	const onPick = (event: Event & { currentTarget: HTMLInputElement }) => {
		const chosen = event.currentTarget.files;
		if (chosen && chosen.length > 0) uploadFiles(Array.from(chosen));
		event.currentTarget.value = '';
	};

	const removeAttachment = (id: string) => {
		if (!sessionId) return;
		void deleteAttachment(sessionId, id).then(
			() => setAttachments(
				(current) => current.filter((item) => item.id !== id),
			),
		).catch(
			(error: unknown) => setAttachError(
				error instanceof Error
					? error.message
					: t('sandbox.attachments.removeFailed'),
			),
		);
	};

	const dismissPending = (key: string) => setPending(
		(current) => current.filter((item) => item.key !== key),
	);

	/* Restoring replaces the draft files, so a full reload lets the app re-open
   the session from the URL: the transcript picks up the marker and the
   preview nonce is bumped as the session mounts again. */
	const doRestore = (sequence: number) => {
		if (!sessionId || restoring) return;
		setRestoring(true);
		setRestoreError('');
		void restoreCheckpoint(sessionId, sequence).then(() => {
			window.location.reload();
		}).catch((error: unknown) => {
			setRestoring(false);
			setRestoreError(
				error instanceof Error
					? error.message
					: t('sandbox.chat.restore.failed'),
			);
		});
	};

	const restoreRow = (key: number) => {
		const checkpoint = checkpointFor(key);
		if (!checkpoint || props.running) return null;
		return <div class="chat__restore">
			{confirmRestore === checkpoint.sequence
				? <>
						<span class="chat__restore-ask">{t(
							'sandbox.chat.restore.confirm',
						)}</span>
						<button
							class="chat__restore-go"
							type="button"
							disabled={restoring}
							onClick={() => doRestore(checkpoint.sequence)}
						>
							<Icon name="refresh" size={12} />
							{restoring
								? t('sandbox.chat.restore.restoring')
								: t('sandbox.common.restore')}
						</button>
						<button
							class="chat__restore-cancel"
							type="button"
							disabled={restoring}
							onClick={() => setConfirmRestore(null)}
						>{t('sandbox.common.cancel')}</button>
						{restoreError
							? <span class="chat__restore-error">{restoreError}</span>
							: null}
					</>
				: <button
						class="chat__restore-toggle"
						type="button"
						onClick={() => {
							setRestoreError('');
							setConfirmRestore(checkpoint.sequence);
						}}
					>
						<Icon name="refresh" size={12} />
						{checkpoint.sequence === 0
							? t('sandbox.chat.restore.start')
							: t('sandbox.chat.restore.here')}
					</button>}
		</div>;
	};

	const [freshContext, setFreshContext] = useState(false);
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		props.onSend(freshContext);
		setFreshContext(false);
	};

	<section class="sandbox__chat">
		<div
			class="sandbox__scroll"
			ref={scroller}
			onScroll={(event) => {
				const node = event.currentTarget;
				followLatest.current = node.scrollHeight - node.scrollTop -
					node.clientHeight <
				64;
			}}
		>
			<div class="chat sandbox__column">
				@for (const block of stream; key blockKey(block)) {
					@if (block.events) {
						<ul class="chat__events">
							@for (const row of block.events; key row.key) {
								@if (
									row.entry.event?.type === 'tool.started' ||
										row.entry.event?.type === 'tool.completed'
								) {
									<li>
										<ToolEvent row={row} running={props.running} />
									</li>
								} @else {
									<li
										class={[
											'chat__event',
											isActive(row.entry) && 'chat__event--active',
											isError(row.entry) && 'chat__event--error',
										]}
										title={eventLabel(row.entry)}
									>
										<Icon
											name={isError(row.entry)
												? 'alert'
												: isActive(row.entry)
													? 'refresh'
													: 'check'}
											size={14}
										/>
										<span class="chat__event-text">{eventLabel(
											row.entry,
										)}</span>
									</li>
								}
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
								<span>{roleLabel(
									block.entry!.handoff!.role,
									block.entry!.handoff!.roleName,
								)}</span>
								<Tag>{handoffLabel(block.entry!.handoff!)}</Tag>
								{moduleLabel(block.entry!)}
							</header>
							<p class="chat__text">{t(
								'sandbox.handoff.description.' + block.entry!.handoff!.kind,
							)}</p>
							@if (block.entry!.text) {
								<details
									open={block.entry!.handoff!.kind === 'question' ||
										block.entry!.handoff!.kind === 'blocked'}
								>
									<summary>{t('sandbox.handoff.details')}</summary>
									<p class="chat__text">{block.entry!.text}</p>
								</details>
							}
							@if (block.entry!.sequence === open) {
								@if (block.entry!.handoff!.kind === 'question') {
									<PendingQuestionsCard
										pending={props.pendingQuestions}
										loading={props.running}
										denied={props.delivered || props.archived}
										busy={props.busy === true}
										error={props.answersError}
										onSubmit={props.onAnswers}
									/>
								} @else if (
									block.entry!.handoff!.kind === 'approval' && !props.running
								) {
									<ApprovalHandoff
										handoff={block.entry!.handoff!}
										reviews={props.specs}
										busy={props.running || props.busy === true}
										onApprove={props.onApprove}
										onRequestChanges={props.onRequestChanges}
										onEdit={props.onEditSpec}
									/>
								} @else if (
									block.entry!.handoff!.kind === 'continue' && !props.running
								) {
									<div class="ui-form__actions">
										<Button
											size="sm"
											variant="primary"
											disabled={props.busy === true}
											onClick={() => props.onContinue(block.entry!.handoff!)}
										>
											<Icon name="play" size={14} />
											{t('sandbox.chat.continueWith', {
												role: roleLabel(
													block.entry!.handoff!.role,
													block.entry!.handoff!.roleName,
												),
											})}
										</Button>
									</div>
								}
							}
							{restoreRow(block.key)}
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
									{block.entry!.kind === 'user'
										? t('sandbox.chat.you')
										: roleLabel(block.entry!.role)}
								</span>
								{moduleLabel(block.entry!)}
							</header>
							<p class="chat__text">{block.speech}</p>
							@if (block.questions.length > 0) {
								<ul>
									@for (const question of block.questions; key question.id) {
										<li>
											<span class="ui-mono">{question.id}</span>
											{' ' + question.question}
											@if (question.options.length > 0) {
												<span class="ui-help">{question.options.join(
													' · ',
												)}</span>
											}
										</li>
									}
								</ul>
							}
							{restoreRow(block.key)}
						</article>
					}
				}
				@if (props.pendingBrief && !props.running) {
					<article class="chat__handoff chat__handoff--continue">
						<header class="chat__meta">
							<Icon name="play" size={14} />
							<span>{t('sandbox.chat.notStarted')}</span>
						</header>
						<p class="chat__text">{t('sandbox.chat.pendingBrief', {
							brief: props.pendingBrief,
						})}</p>
						<div class="ui-form__actions">
							<Button size="sm" variant="primary" onClick={props.onStart}>
								<Icon name="play" size={14} />
								{t('sandbox.chat.startWork')}
							</Button>
						</div>
					</article>
				}
			</div>
		</div>

		<form class="chat__composer" onSubmit={submit}>
			@if (props.selection) {
				<div class="chat__selection">
					<b>{t('sandbox.chat.selection', {
						label: props.selection.label,
					})}</b>
					<span class="ui-mono">{props.selection.selector}</span>
					<div class="ui-form__actions">
						<Button
							size="sm"
							variant="ghost"
							onClick={props.onClearSelection}
						>{t('sandbox.chat.clearSelection')}</Button>
					</div>
				</div>
			}
			@if (attachments.length > 0 || pending.length > 0 || attachError) {
				<div class="chat__attachments">
					@for (const item of attachments; key item.id) {
						<div class="chat__attachment">
							@if (item.kind === 'image') {
								<img
									class="chat__attachment-thumb"
									src={attachmentUrl(sessionId, item.id)}
									alt={item.name}
								/>
							} @else {
								<span
									class="chat__attachment-thumb chat__attachment-thumb--file"
								>
									<Icon name="file-text" size={18} />
								</span>
							}
							<span class="chat__attachment-info">
								<span class="chat__attachment-name">{item.name}</span>
								<span class="chat__attachment-size">{formatBytes(
									item.size,
								)}</span>
							</span>
							<button
								class="chat__attachment-remove"
								type="button"
								aria-label={t('sandbox.attachments.remove', {
									name: item.name,
								})}
								onClick={() => removeAttachment(item.id)}
							>
								<Icon name="x" size={12} />
							</button>
						</div>
					}
					@for (const item of pending; key item.key) {
						<div
							class={[
								'chat__attachment',
								item.status === 'error' && 'chat__attachment--error',
							]}
						>
							<span class="chat__attachment-thumb chat__attachment-thumb--file">
								<Icon
									name={item.status === 'error' ? 'alert' : 'file-text'}
									size={18}
								/>
							</span>
							<span class="chat__attachment-info">
								<span class="chat__attachment-name">{item.name}</span>
								<span class="chat__attachment-size">
									{item.status === 'error'
										? item.error ?? t('sandbox.attachments.uploadFailed')
										: t('sandbox.attachments.uploading')}
								</span>
							</span>
							<button
								class="chat__attachment-remove"
								type="button"
								aria-label={t('sandbox.common.dismiss')}
								onClick={() => dismissPending(item.key)}
							>
								<Icon name="x" size={12} />
							</button>
						</div>
					}
					@if (attachError) {
						<span class="chat__attachment-error">{attachError}</span>
					}
				</div>
			}
			<textarea
				class="ui-textarea"
				rows={3}
				placeholder={t('sandbox.chat.placeholder')}
				value={props.message}
				onInput={(event) => props.onMessage(event.currentTarget.value)}
				onPaste={onPaste}
			></textarea>
			<div class="chat__composer-row">
				<ComposerSettings
					autoContinue={props.autoContinue}
					freshContext={freshContext}
					running={props.running}
					onAutoContinue={props.onAutoContinue}
					onFreshContext={setFreshContext}
				/>
				<button
					class="chat__attach"
					type="button"
					aria-label={t('sandbox.attachments.action')}
					title={t('sandbox.attachments.help')}
					disabled={!sessionId}
					onClick={() => attachInput.current?.click()}
				>
					<Icon name="plus" size={16} />
				</button>
				<input
					ref={attachInput}
					class="chat__attach-input"
					type="file"
					multiple
					accept={ATTACH_ACCEPT}
					onChange={onPick}
				/>
				<select
					class="chat__picker"
					aria-label={t('sandbox.chat.role')}
					value={props.role}
					onChange={(event) => props.onRole(event.currentTarget.value)}
				>
					<option value="auto">{t('sandbox.chat.auto')}</option>
					@for (const role of props.roles; key role.id) {
						<option value={role.id}>{roleLabel(role.id, role.name)}</option>
					}
				</select>
				@if (props.modules.length > 1) {
					<select
						class="chat__picker"
						aria-label={t('sandbox.chat.targetModule')}
						value={props.module}
						onChange={(event) => props.onModule(event.currentTarget.value)}
					>
						<option value="">{t('sandbox.chat.auto')}</option>
						@for (const module of props.modules; key module.id) {
							<option value={module.directory}>{module.id}</option>
						}
					</select>
				}
				<select
					class="chat__picker"
					aria-label={t('sandbox.sessions.driver.label')}
					value={props.driver}
					onChange={(event) => props.onDriver(event.currentTarget.value)}
				>
					@for (const driver of offered; key driver.id) {
						<option value={driver.id}>{driver.label}</option>
					}
				</select>
				<span class="sandbox__spacer"></span>
				@if (props.running) {
					<Button size="sm" variant="danger" onClick={props.onStop}>{t(
						'sandbox.chat.stop',
					)}</Button>
				} @else {
					<Button
						size="sm"
						variant="primary"
						type="submit"
						disabled={props.message.trim().length === 0}
					>
						<Icon name="play" size={14} />
						{t('sandbox.chat.send')}
					</Button>
				}
			</div>
			@if (props.running || props.delivered) {
				<p class="chat__composer-status">
					{props.running
						? <TurnActivity lastUpdateAt={props.entries.at(-1)?.at} />
						: t('sandbox.chat.delivered')}
				</p>
			}
		</form>
	</section>
}
