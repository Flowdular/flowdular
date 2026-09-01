import { useEffect, useMemo } from 'octane';
import { Alert, BrandMark, Button, Icon, Tag } from '@coreloom/ui';
import { useValue } from 'segment-state';
import type { RenderRouteProps } from '@octanejs/vite-plugin';
import type {
	ChatEntry,
	HandoffPlan,
	SandboxSession,
} from './server/sessions.ts';
import {
	approveSpecification,
	archiveSandboxSession,
	connectBrowser,
	createSandboxSession,
	deleteSandboxSession,
	followTurn,
	loadSandboxState,
	loadSession,
	formatSession,
	planEject,
	restoreSandboxSession,
	runGates,
	saveConfiguration,
	setAutoContinue,
	stopTurn,
	streamEject,
	streamTurn,
	type EjectPlanView,
	type EjectTargetId,
	type TurnHandlers,
} from './client/api.ts';
import { ChatPane } from './client/ChatPane.tsrx';
import { ConnectView } from './client/ConnectView.tsrx';
import { SessionBar } from './client/SessionBar.tsrx';
import { WorkspaceMenu } from './client/WorkspaceMenu.tsrx';
import { DiffPane } from './client/DiffPane.tsrx';
import { WorkCard, type WorkCardMode } from './client/WorkCard.tsrx';
import {
	WorkbenchModal,
	type WorkbenchMode,
} from './client/WorkbenchModal.tsrx';
import { SessionPicker } from './client/SessionPicker.tsrx';
import { EjectModal } from './client/EjectModal.tsrx';
import {
	createSandboxClientState,
	mergeEntries,
	mergeSteps,
	signalReady,
	sessionIdFromUrl,
	type PreviewSelection,
} from './client/state.ts';
import '@coreloom/ui/styles';
import './styles.css';

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

/* A session that was created but never ran a turn still knows what it was asked
   for, so it can be started instead of retyped. */
function startingPoint(
	session: SandboxSession,
	entries: readonly ChatEntry[],
): string {
	if (entries.some((entry) => entry.kind === 'user')) return '';
	return session.brief ||
		entries.find((entry) => entry.kind === 'system')?.text ||
		session.title;
}

export function App(props?: RenderRouteProps) @{
	const sandbox = useMemo(() => createSandboxClientState(), []);
	const [state] = useValue(sandbox.state.state);
	const [view] = useValue(sandbox.state.view);
	const [entries] = useValue(sandbox.state.liveEntries);
	const [selection, setSelection] = useValue(sandbox.state.selection);
	const [activeSessionId, setActiveSessionId] = useValue(
		sandbox.state.activeSessionId,
	);
	const [role, setRole] = useValue(sandbox.state.role);
	const [driver, setDriver] = useValue(sandbox.state.driver);
	const [draft, setDraft] = useValue(sandbox.state.message);
	const [workbench, setWorkbench] = useValue(sandbox.state.workbench);
	const [cardMode, setCardMode] = useValue(sandbox.state.cardMode);
	const [nonce, setNonce] = useValue(sandbox.state.previewNonce);
	const [selecting, setSelecting] = useValue(sandbox.state.selecting);
	const [running, setRunning] = useValue(sandbox.state.running);
	const [busy, setBusy] = useValue(sandbox.state.busy);
	const [error, setError] = useValue(sandbox.state.error);
	const [notice, setNotice] = useValue(sandbox.state.notice);
	const [plan, setPlan] = useValue(sandbox.state.ejectPlan);
	const [ejectSteps, setEjectSteps] = useValue(sandbox.state.ejectSteps);
	const [ejectSummary, setEjectSummary] = useValue(sandbox.state.ejectSummary);
	const [ejectError, setEjectError] = useValue(sandbox.state.ejectError);
	const [ejecting, setEjecting] = useValue(sandbox.state.ejecting);
	const [ejectBuild, setEjectBuild] = useValue(sandbox.state.ejectBuild);
	const [menuOpen, setMenuOpen] = useValue(sandbox.state.menuOpen);
	const [connecting, setConnecting] = useValue(sandbox.state.connecting);
	const [sessionMenu, setSessionMenu] = useValue(sandbox.state.sessionMenu);
	const [confirmDelete, setConfirmDelete] = useValue(
		sandbox.state.confirmDelete,
	);
	const [showArchived, setShowArchived] = useValue(sandbox.state.showArchived);
	/* The stream that follows the running turn outlives the render that opened
   it, so its controller lives in a box instead of a render-scoped variable. */
	const turn = useMemo(
		() => ({ controller: null as AbortController | null }),
		[],
	);
	const currentSession = () =>
		sandbox.store.get(sandbox.state.view)?.session ?? null;

	const refreshState = async () => {
		const next = await loadSandboxState();
		sandbox.store.act((transaction) => {
			transaction.set(sandbox.state.state, next);
			transaction.set(sandbox.state.sessions, next.sessions);
		}, 'sandbox/state');
		if (!driver) setDriver(next.configuration.driver);
		return next;
	};

	/* Reloads the transcript and diff of the open session without touching the
   running flag, which the turn stream owns while it is attached. */
	const refreshView = async (id: string) => {
		const loaded = await loadSession(id).catch(() => null);
		if (!loaded || sandbox.store.get(sandbox.state.activeSessionId) !== id) {
			return;
		}
		sandbox.store.act((transaction) => {
			transaction.set(sandbox.state.view, loaded);
			transaction.set(sandbox.state.liveEntries, loaded.chat);
		}, 'sandbox/refresh');
	};

	const detach = () => {
		turn.controller?.abort();
		turn.controller = null;
	};

	/* Whatever stream carries the turn, the screen reacts the same way: entries
   land as they happen, each finished turn refreshes the diff, and the end of
   the chain frees the composer. */
	const handlersFor = (id: string): TurnHandlers => ({
		onEntry: (entry) => {
			sandbox.store.update(
				sandbox.state.liveEntries,
				(current) => mergeEntries(current, [entry]),
				'sandbox/entry',
			);
		},
		onCompleted: () => {
			void refreshView(id);
		},
		onEnded: () => {
			turn.controller = null;
			setRunning(false);
			setSelection(null);
			void refreshView(id).then(() => {
				setNonce(sandbox.store.get(sandbox.state.previewNonce) + 1);
			});
			void refreshState();
		},
		onFailed: (failure) => {
			setError(failure);
		},
	});

	/* A turn keeps running when the browser reloads or another tab started it.
   This browser attaches to it and follows until the sandbox reports the end. */
	const follow = async (id: string) => {
		if (turn.controller !== null) return;
		const following = followTurn(id, handlersFor(id));
		turn.controller = following.controller;
		const attached = await following.attached;
		if (!attached) {
			if (turn.controller === following.controller) turn.controller = null;
			setRunning(false);
		}
	};

	const openSession = async (id: string) => {
		setBusy(true);
		try {
			const loaded = await loadSession(id);
			sandbox.store.act((transaction) => {
				transaction.set(sandbox.state.view, loaded);
				transaction.set(sandbox.state.liveEntries, loaded.chat);
				transaction.set(sandbox.state.activeSessionId, id);
			}, 'sandbox/session');
			setDriver(loaded.session.driver);
			setNonce(nonce + 1);
			history.pushState(null, '', '/sessions/' + id);
			if (turn.controller === null) {
				setRunning(loaded.running);
				if (loaded.running) void follow(id);
			}
		} catch (loadError) {
			setError(message(loadError, 'Could not open the session.'));
		} finally {
			setBusy(false);
		}
	};

	useEffect(() => {
		void (async () => {
			try {
				await refreshState();
				const initial = sessionIdFromUrl(
					new URL(props?.url ??
						window.location.href, 'http://sandbox.local').pathname,
				);
				if (initial) await openSession(initial);
			} catch (loadError) {
				setError(message(loadError, 'The sandbox state is unavailable.'));
			} finally {
				signalReady();
			}
		})();

		const onMessage = (event: MessageEvent) => {
			const data = event.data as PreviewSelection & { type?: string };
			if (data?.type !== 'coreloom:selection') return;
			setSelection({
				label: data.label,
				selector: data.selector,
				view: data.view,
				text: data.text,
			});
			setSelecting(false);
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, []);

	/* One turn, wherever it came from: an operator message or a handoff the
   operator confirmed. Automatic handoffs are chained by the server on the
   same stream, so this browser only has to follow it. */
	const dispatch = (session: SandboxSession, text: string, roleId: string) => {
		detach();
		setRunning(true);
		setError('');
		turn.controller = streamTurn(
			session.id,
			{
				message: text,
				role: roleId,
				driver: sandbox.store.get(sandbox.state.driver) || session.driver,
			},
			handlersFor(session.id),
		);
	};

	/* One brief starts everything: the planner names the modules and the first
   specialist, then the same brief becomes the first turn, so a new session
   is already working when it opens. */
	const startSession = async (brief: string, chosenDriver: string) => {
		setBusy(true);
		setError('');
		try {
			const created = await createSandboxSession(brief, chosenDriver);
			await refreshState();
			await openSession(created.session.id);
			dispatch(created.session, brief, 'auto');
		} catch (createError) {
			setError(message(createError, 'Could not start the session.'));
		} finally {
			setBusy(false);
		}
	};

	const send = (explicit?: string) => {
		const session = currentSession();
		if (!session || sandbox.store.get(sandbox.state.running)) return;
		const text = (explicit ?? draft).trim();
		if (!text) return;
		const withSelection = selection
			? `${text}\n\nSelected element in the preview: ${selection.label}\nPath: ${selection.selector}${
					selection.view ? `\nView: ${selection.view}` : ''
				}`
			: text;
		setDraft('');
		dispatch(session, withSelection, role);
	};

	const continueWith = (handoff: HandoffPlan) => {
		const session = currentSession();
		if (!session || running) return;
		dispatch(session, handoff.prompt, handoff.role);
	};

	const approveAndContinue = async (handoff: HandoffPlan) => {
		const session = currentSession();
		if (!session || running) return;
		setBusy(true);
		setError('');
		try {
			await approveSpecification(session.id);
			await openSession(session.id);
			dispatch(session, handoff.prompt, handoff.role);
		} catch (approveError) {
			setError(
				message(approveError, 'The specification could not be approved.'),
			);
		} finally {
			setBusy(false);
		}
	};

	const toggleAutoContinue = async (enabled: boolean) => {
		const session = currentSession();
		if (!session) return;
		try {
			await setAutoContinue(session.id, enabled);
			await refreshView(session.id);
		} catch (settingError) {
			setError(message(settingError, 'Could not change the handoff setting.'));
		}
	};

	const stop = () => {
		const session = currentSession();
		detach();
		setRunning(false);
		if (session) {
			void stopTurn(session.id).then(() => openSession(session.id));
		}
	};

	const validate = async () => {
		const session = view?.session;
		if (!session) return;
		setBusy(true);
		try {
			await formatSession(session.id);
			const result = await runGates(session.id);
			setNotice(
				result.gates.map((gate) => `${gate.id}: ${gate.status}`).join(' · ') ||
					'No gate ran.',
			);
			await openSession(session.id);
		} catch (gateError) {
			setError(message(gateError, 'The gates could not run.'));
		} finally {
			setBusy(false);
		}
	};

	const startEject = async (target?: EjectTargetId) => {
		const session = view?.session;
		if (!session) return;
		setBusy(true);
		setError('');
		try {
			const result = await planEject(session.id, target);
			setPlan(result.plan);
			setNotice('');
		} catch (planError) {
			setError(message(planError, 'The eject plan could not be prepared.'));
		} finally {
			setBusy(false);
		}
	};

	const confirmEject = () => {
		const session = view?.session;
		if (!session || ejecting) return;
		sandbox.store.act((transaction) => {
			transaction.set(sandbox.state.ejecting, true);
			transaction.set(sandbox.state.ejectSteps, []);
			transaction.set(sandbox.state.ejectSummary, null);
			transaction.set(sandbox.state.ejectError, '');
		}, 'sandbox/eject-start');
		streamEject(
			session.id,
			{
				onStep: (step) => sandbox.store.update(
					sandbox.state.ejectSteps,
					(current) => mergeSteps(current, step),
					'sandbox/eject-step',
				),
				onDone: (summary) => {
					setEjecting(false);
					setEjectSummary(summary);
					void openSession(session.id);
					void refreshState();
				},
				onFailed: (failure) => {
					setEjecting(false);
					setEjectError(failure);
				},
			},
			{ build: ejectBuild, target: plan?.target },
		);
	};

	const closeEject = () => {
		sandbox.store.act((transaction) => {
			transaction.set(sandbox.state.ejectPlan, null);
			transaction.set(sandbox.state.ejectSteps, []);
			transaction.set(sandbox.state.ejectSummary, null);
			transaction.set(sandbox.state.ejectError, '');
			transaction.set(sandbox.state.ejecting, false);
		}, 'sandbox/eject-close');
	};

	const backToSessions = () => {
		detach();
		setRunning(false);
		sandbox.store.act((transaction) => {
			transaction.set(sandbox.state.activeSessionId, '');
			transaction.set(sandbox.state.view, null);
			transaction.set(sandbox.state.liveEntries, []);
			transaction.set(sandbox.state.workbench, 'none');
			transaction.set(sandbox.state.notice, '');
			transaction.set(sandbox.state.error, '');
		}, 'sandbox/sessions');
		history.pushState(null, '', '/');
		void refreshState();
	};

	/* Session lifecycle from the list. Every action closes the menu and reloads
   the list, so the card reflects what the server did. */
	const sessionAction = async (
		id: string,
		action: () => Promise<unknown>,
		failure: string,
	) => {
		setBusy(true);
		setError('');
		sandbox.store.act((transaction) => {
			transaction.set(sandbox.state.sessionMenu, '');
			transaction.set(sandbox.state.confirmDelete, '');
		}, 'sandbox/session-menu');
		try {
			await action();
			await refreshState();
		} catch (actionError) {
			setError(message(actionError, failure));
		} finally {
			setBusy(false);
		}
	};

	const disconnect = async () => {
		setBusy(true);
		try {
			await saveConfiguration({ disconnect: true });
			await refreshState();
			backToSessions();
		} catch (disconnectError) {
			setError(message(disconnectError, 'Could not disconnect the sandbox.'));
		} finally {
			setBusy(false);
		}
	};

	const setPreviewData = async (mode: 'fixtures' | 'bridge') => {
		try {
			await saveConfiguration({ previewData: mode });
			await refreshState();
			setNonce(nonce + 1);
		} catch (configError) {
			setError(message(configError, 'Could not change the preview data mode.'));
		}
	};

	/* A self-hosted sandbox signs this browser in first; the configuration call
   that follows is then an authenticated one. */
	const connect = async (input: {
		platformUrl: string;
		platformToken: string;
	}) => {
		setBusy(true);
		setError('');
		try {
			if (state?.configuration.mode === 'self-hosted') {
				await connectBrowser({
					token: input.platformToken,
					platformUrl: input.platformUrl,
				});
			}
			const result = await saveConfiguration(input);
			await refreshState();
			setConnecting(false);
			if (!result.connection.connected) {
				setError(
					result.connection.error?.message ??
						'The sandbox could not connect to that application.',
				);
			}
		} catch (connectError) {
			setError(message(connectError, 'Could not save the connection.'));
		} finally {
			setBusy(false);
		}
	};

	<div>
		@if (!state) {
			<div class="connect">
				<p class="ui-help">Starting the sandbox…</p>
			</div>
		} @else if (!state.connection.connected || connecting) {
			<ConnectView
				state={state}
				busy={busy}
				error={error}
				onConnect={(input) => void connect(input)}
			/>
		} @else {
			<div class="sandbox">
				<header class="sandbox__bar">
					<button
						class="sandbox__brand"
						type="button"
						onClick={() => backToSessions()}
					>
						<BrandMark size={20} />
						Coreloom sandbox
					</button>
					<Tag mono>{state.configuration.mode}</Tag>
					<span class="sandbox__spacer"></span>
					<WorkspaceMenu
						state={state}
						open={menuOpen}
						onToggle={() => setMenuOpen(!menuOpen)}
						onChangeConnection={() => {
							setMenuOpen(false);
							setConnecting(true);
						}}
						onDisconnect={() => {
							setMenuOpen(false);
							void disconnect();
						}}
					/>
				</header>

				<div class="sandbox__notice">
					@if (error) {
						<Alert>{error}</Alert>
					} @else if (notice) {
						<Alert tone="info">{notice}</Alert>
					}
				</div>
				@if (plan) {
					<EjectModal
						plan={plan}
						steps={ejectSteps}
						summary={ejectSummary}
						error={ejectError}
						running={ejecting}
						build={ejectBuild}
						onBuild={setEjectBuild}
						onTarget={(target) => void startEject(target)}
						onConfirm={confirmEject}
						onClose={closeEject}
					/>
				}

				@if (!activeSessionId || !view) {
					<div class="sandbox__scroll">
						<SessionPicker
							sessions={state.sessions}
							running={state.running}
							roles={state.roles}
							drivers={state.drivers}
							driver={driver || state.configuration.driver}
							busy={busy}
							openMenu={sessionMenu}
							confirmDelete={confirmDelete}
							showArchived={showArchived}
							onDriver={setDriver}
							onOpen={(id) => void openSession(id)}
							onCreate={(brief, chosen) => void startSession(brief, chosen)}
							onMenu={(id) => {
								setSessionMenu(id);
								setConfirmDelete('');
							}}
							onShowArchived={setShowArchived}
							onArchive={(id) => void sessionAction(
								id,
								() => archiveSandboxSession(id),
								'Could not archive the session.',
							)}
							onRestore={(id) => void sessionAction(
								id,
								() => restoreSandboxSession(id),
								'Could not restore the session.',
							)}
							onConfirmDelete={setConfirmDelete}
							onDelete={(id) => void sessionAction(
								id,
								() => deleteSandboxSession(id),
								'Could not delete the session.',
							)}
						/>
					</div>
				} @else {
					<>
						<SessionBar
							session={view.session}
							changes={view.diffs.length}
							busy={busy}
							onBack={backToSessions}
							onGates={() => void validate()}
							onChanges={() => setWorkbench('diff')}
							onEject={() => void startEject()}
						/>
						<div class="sandbox__body">
							<ChatPane
								entries={entries}
								delivered={Boolean(view.session.ejectedAt)}
								roles={state.roles}
								drivers={state.drivers}
								role={role}
								driver={driver}
								message={draft}
								running={running}
								selection={selection}
								autoContinue={view.session.autoContinue}
								pendingBrief={startingPoint(view.session, entries)}
								onStart={() => send(startingPoint(view.session, entries))}
								onContinue={continueWith}
								onApprove={(handoff) => void approveAndContinue(handoff)}
								onAutoContinue={(enabled) => void toggleAutoContinue(enabled)}
								onRole={setRole}
								onDriver={setDriver}
								onMessage={setDraft}
								onSend={() => send()}
								onStop={stop}
								onClearSelection={() => setSelection(null)}
							/>
							<aside class="sandbox__side">
								<WorkCard
									session={view.session}
									diffs={view.diffs}
									mode={cardMode as WorkCardMode}
									nonce={nonce}
									previewData={state.configuration.previewData}
									onMode={(mode) => setCardMode(mode)}
									onOpen={() => setWorkbench(
										cardMode === 'code' ? 'diff' : 'preview',
									)}
									onReload={() => setNonce(nonce + 1)}
									onAskAbout={(path) => setDraft(
										draft
											? draft + '\n\nAbout ' + path + ': '
											: 'About ' + path + ': ',
									)}
								/>
							</aside>
						</div>
					</>
				}
				@if (workbench !== 'none') {
					<WorkbenchModal
						mode={workbench as WorkbenchMode}
						session={view!.session}
						diffs={view!.diffs}
						nonce={nonce}
						selecting={selecting}
						previewData={state.configuration.previewData}
						onMode={(mode) => setWorkbench(mode)}
						onToggleSelect={() => {
							setSelecting(!selecting);
							setNonce(nonce + 1);
						}}
						onReload={() => setNonce(nonce + 1)}
						onPreviewData={(mode) => void setPreviewData(mode)}
						onAskAbout={(path) => {
							setDraft(
								draft
									? draft + '\n\nAbout ' + path + ': '
									: 'About ' + path + ': ',
							);
							setWorkbench('none');
						}}
						onClose={() => setWorkbench('none')}
					/>
				}
			</div>
		}
	</div>
}
