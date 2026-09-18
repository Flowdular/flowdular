import { useEffect, useRef } from 'octane';
import { Button, Icon, trapFocus } from '@flowdular/ui';
import { t, workspaceViewHref } from '@flowdular/client';
import { useValue } from 'segment-state';
import type {
	AssistantConversation,
	AssistantReadiness,
	AssistantTurn,
} from '../domain/types.ts';
import {
	continueAssistantThread,
	loadAssistantThread,
	loadAssistantThreads,
	startAssistantThread,
} from './api.ts';
import {
	createAssistantState,
	pendingTurn,
	THREAD_PAGE_SIZE,
	TURN_POLL_LIMIT,
	TURN_POLL_MS,
} from './assistant-state.ts';

export interface AssistantPanelProps {
	readonly csrfToken: string;
	readonly readiness: AssistantReadiness | null;
	readonly state: ReturnType<typeof createAssistantState>;
	readonly onClose: () => void;
}

const LOCKED_STEPS = ['provider', 'binding'] as const;

/* Which locked step is already behind the member: a missing binding means the
   provider is there, and anything else means neither is. */
function stepDone(
	readiness: AssistantReadiness | null,
	step: (typeof LOCKED_STEPS)[number],
): boolean {
	if (readiness === null) return false;
	return step === 'provider' ? readiness.providerReady : false;
}

function turnFailure(turn: AssistantTurn): string {
	return turn.failureCode === null
		? t('agents.assistant.turn.failed')
		: t('agents.assistant.turn.failedWithCode', { code: turn.failureCode });
}

export function AssistantPanel(props: AssistantPanelProps) @{
	const { store, state } = props.state;
	const [conversation, setConversation] = useValue(state.conversation);
	const [threads, setThreads] = useValue(state.threads);
	const [historyOpen, setHistoryOpen] = useValue(state.historyOpen);
	const [draft, setDraft] = useValue(state.draft);
	const [status, setStatus] = useValue(state.status);
	const [error, setError] = useValue(state.error);
	const panelRef = useRef<HTMLElement | null>(null);
	const streamRef = useRef<HTMLDivElement | null>(null);
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const formRef = useRef<HTMLFormElement | null>(null);
	const ready = props.readiness?.ready === true;
	const waiting = pendingTurn(conversation);

	const fail = (thrown: unknown, fallback: string) => setError(
		thrown instanceof Error ? thrown.message : t(fallback),
	);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') props.onClose();
		};
		window.addEventListener('keydown', onKeyDown);
		const panel = panelRef.current;
		const release =
			panel === null ? undefined : trapFocus(panel);
		composerRef.current?.focus();
		return () => {
			window.removeEventListener('keydown', onKeyDown);
			release?.();
		};
	}, []);

	useEffect(() => {
		if (!ready) return;
		void loadAssistantThreads(THREAD_PAGE_SIZE).then(
			(page) => setThreads(page.items),
		).catch(() => setThreads([]));
	}, [ready]);

	/* A queued turn is answered by a run the panel never sees. Reading the
   thread is what settles it, so the open conversation polls until no turn is
   pending, and gives up rather than polling a stuck run forever. */
	useEffect(() => {
		const threadId = conversation?.thread.id;
		if (!threadId || !waiting) return;
		let attempts = 0;
		let cancelled = false;
		const timer = setInterval(() => {
			if (cancelled) return;
			attempts += 1;
			if (attempts > TURN_POLL_LIMIT) {
				clearInterval(timer);
				setError(t('agents.assistant.error.timeout'));
				return;
			}
			void loadAssistantThread(threadId).then((fresh) => {
				if (!cancelled) setConversation(fresh);
			}).catch(() => {});
		}, TURN_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [conversation?.thread.id, waiting]);

	/* The newest turn is the one being read, so every change scrolls to it. */
	useEffect(() => {
		const stream = streamRef.current;
		if (stream) stream.scrollTop = stream.scrollHeight;
	}, [conversation?.turns.length, waiting]);

	const send = async (event: SubmitEvent) => {
		event.preventDefault();
		const message = draft.trim();
		if (message === '' || status === 'sending') return;
		setStatus('sending');
		setError('');
		try {
			const threadId = conversation?.thread.id;
			const fresh = threadId
				? await continueAssistantThread(threadId, message, props.csrfToken)
				: await startAssistantThread(message, props.csrfToken);
			store.act((transaction) => {
				transaction.set(state.conversation, fresh);
				transaction.set(state.draft, '');
			}, 'assistant/turn-sent');
			void loadAssistantThreads(THREAD_PAGE_SIZE).then(
				(page) => setThreads(page.items),
			).catch(() => {});
		} catch (thrown) {
			fail(thrown, 'agents.assistant.error.send');
		} finally {
			setStatus('idle');
		}
	};

	const openThread = async (id: string) => {
		setStatus('loading');
		setError('');
		try {
			setConversation(await loadAssistantThread(id));
			setHistoryOpen(false);
		} catch (thrown) {
			fail(thrown, 'agents.assistant.error.open');
		} finally {
			setStatus('idle');
		}
	};

	const startFresh = () => {
		store.act((transaction) => {
			transaction.set(state.conversation, null);
			transaction.set(state.historyOpen, false);
			transaction.set(state.error, '');
		}, 'assistant/new-thread');
		composerRef.current?.focus();
	};

	const suggestions: readonly string[] = [
		t('agents.assistant.suggestion.first'),
		t('agents.assistant.suggestion.second'),
		t('agents.assistant.suggestion.third'),
	];

	<div class="assistant-layer">
		<div
			class="assistant-scrim"
			role="presentation"
			onClick={() => props.onClose()}
		></div>
		<aside
			class="assistant-panel"
			role="dialog"
			aria-modal="true"
			aria-label={t('agents.assistant.title')}
			tabIndex={-1}
			ref={panelRef}
		>
			<header class="assistant-panel__head">
				@if (ready) {
					<button
						class="assistant-icon-button"
						type="button"
						aria-label={t('agents.assistant.history.open')}
						aria-expanded={historyOpen}
						onClick={() => setHistoryOpen(!historyOpen)}
					>
						<Icon name="message" size={16} />
					</button>
				}
				<span class="assistant-panel__title">
					<b>{t('agents.assistant.title')}</b>
					<small>
						{!ready
							? t('agents.assistant.subtitle.locked')
							: waiting
								? t('agents.assistant.subtitle.working')
								: t('agents.assistant.subtitle.ready')}
					</small>
				</span>
				@if (ready) {
					<button
						class="assistant-icon-button"
						type="button"
						aria-label={t('agents.assistant.thread.new')}
						onClick={startFresh}
					>
						<Icon name="plus" size={16} />
					</button>
				}
				<button
					class="assistant-icon-button"
					type="button"
					aria-label={t('agents.assistant.close')}
					onClick={() => props.onClose()}
				>
					<Icon name="x" size={16} />
				</button>
			</header>

			@if (!ready) {
				<div class="assistant-locked">
					<span class="assistant-locked__mark" aria-hidden="true">
						<Icon name="lock" size={22} />
					</span>
					<b>{t('agents.assistant.locked.title')}</b>
					<p>
						{props.readiness?.lockedReason === 'disabled'
							? t('agents.assistant.locked.disabled')
							: props.readiness?.lockedReason === 'forbidden'
								? t('agents.assistant.locked.forbidden')
								: t('agents.assistant.locked.description')}
					</p>
					@if (props.readiness?.configureHref) {
						<>
							<ol class="assistant-steps">
								@for (const step of LOCKED_STEPS; key step) {
									<li
										class={[
											'assistant-step',
											stepDone(props.readiness, step) && 'assistant-step--done',
										]}
									>
										<span class="assistant-step__num" aria-hidden="true">
											@if (stepDone(props.readiness, step)) {
												<Icon name="check" size={11} />
											} @else {
												{
													step === 'provider' ? '1' : '2';
												}
											}
										</span>
										{t('agents.assistant.locked.step.' + step)}
									</li>
								}
							</ol>
							<a
								class="ui-btn ui-btn--primary"
								href={workspaceViewHref(
									props.readiness.configureHref.replace(/^\//, ''),
								)}
								onClick={() => props.onClose()}
							>{t('agents.assistant.locked.configure')}</a>
						</>
					}
				</div>
			} @else {
				<div class="assistant-body">
					@if (historyOpen) {
						<div class="assistant-history">
							<div class="assistant-history__head">
								<span>{t('agents.assistant.history.title')}</span>
								<span>{t('agents.assistant.history.private')}</span>
							</div>
							@if (threads.length === 0) {
								<p class="assistant-history__empty">{t(
									'agents.assistant.history.empty',
								)}</p>
							}
							@for (const thread of threads; key thread.id) {
								<button
									class={[
										'assistant-thread',
										thread.id === conversation?.thread.id &&
											'assistant-thread--active',
									]}
									type="button"
									onClick={() => void openThread(thread.id)}
								>
									<b>{thread.title}</b>
									<span>{t('agents.assistant.turns', {
										count: thread.turnCount,
									})}</span>
								</button>
							}
						</div>
					}

					<div class="assistant-stream" ref={streamRef}>
						@if (conversation === null) {
							<>
								<div class="assistant-message assistant-message--agent">
									<span class="assistant-message__who">
										<Icon name="sparkle" size={12} />
										{t('agents.assistant.name')}
									</span>
									<p>{t('agents.assistant.greeting')}</p>
								</div>
								@for (const suggestion of suggestions; key suggestion) {
									<button
										class="assistant-suggestion"
										type="button"
										onClick={() => {
											setDraft(suggestion);
											composerRef.current?.focus();
										}}
									>{suggestion}</button>
								}
							</>
						}

						@for (const turn of conversation?.turns ?? []; key turn.id) {
							<>
								<div
									class="assistant-message assistant-message--member"
								>{turn.question}</div>
								@if (turn.status === 'pending') {
									<div class="assistant-message assistant-message--agent">
										<span class="assistant-message__who">
											<Icon name="sparkle" size={12} />
											{t('agents.assistant.name')}
										</span>
										<span
											class="assistant-typing"
											aria-label={t('agents.assistant.turn.working')}
										>
											<i></i>
											<i></i>
											<i></i>
										</span>
									</div>
								} @else if (turn.status === 'failed') {
									<p class="assistant-turn-failed">{turnFailure(turn)}</p>
								} @else {
									<div class="assistant-message assistant-message--agent">
										<span class="assistant-message__who">
											<Icon name="sparkle" size={12} />
											{t('agents.assistant.name')}
										</span>
										<p>{turn.answer ?? ''}</p>
									</div>
								}
							</>
						}
					</div>

					<form class="assistant-composer" onSubmit={send} ref={formRef}>
						@if (error) {
							<p class="assistant-composer__error" role="alert">{error}</p>
						}
						<div class="assistant-composer__box">
							<textarea
								class="assistant-composer__input"
								rows={1}
								value={draft}
								ref={composerRef}
								placeholder={t('agents.assistant.composer.placeholder')}
								aria-label={t('agents.assistant.composer.placeholder')}
								maxLength={8_000}
								onInput={(event) => setDraft(event.currentTarget.value)}
								onKeyDown={(event: KeyboardEvent) => {
									if (event.key === 'Enter' && !event.shiftKey) {
										event.preventDefault();
										formRef.current?.requestSubmit();
									}
								}}
							></textarea>
							<Button
								variant="primary"
								type="submit"
								disabled={status === 'sending' || draft.trim() === ''}
							>
								<Icon name="chevron-right" size={16} />
							</Button>
						</div>
						<small class="assistant-composer__note">
							<Icon name="shield" size={12} />
							{t('agents.assistant.composer.note')}
						</small>
					</form>
				</div>
			}
		</aside>
	</div>
}
