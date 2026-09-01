import { Button, EmptyState, Icon, Tag } from '@coreloom/ui';
import type { SandboxSession } from '../server/sessions.ts';
import type { DriverSummary, RoleSummary } from './api.ts';

export interface SessionPickerProps {
	readonly sessions: readonly SandboxSession[];
	/* Ids of the sessions with a turn in flight; those cannot be deleted. */
	readonly running: readonly string[];
	readonly roles: readonly RoleSummary[];
	readonly drivers: readonly DriverSummary[];
	readonly driver: string;
	readonly busy: boolean;
	/* The card whose action menu is open, and the one waiting for a delete
   confirmation; empty when none. */
	readonly openMenu: string;
	readonly confirmDelete: string;
	readonly showArchived: boolean;
	readonly onDriver: (driver: string) => void;
	readonly onOpen: (id: string) => void;
	readonly onCreate: (brief: string, driver: string) => void;
	readonly onMenu: (id: string) => void;
	readonly onShowArchived: (show: boolean) => void;
	readonly onArchive: (id: string) => void;
	readonly onRestore: (id: string) => void;
	readonly onConfirmDelete: (id: string) => void;
	readonly onDelete: (id: string) => void;
}

function stateTone(
	session: SandboxSession,
): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
	if (session.archivedAt) return 'neutral';
	if (session.state === 'accepted') return 'success';
	if (
		session.state === 'failed' || session.state === 'blocked'
	) return 'danger';
	if (session.state === 'awaiting-approval' || session.state === 'validating') {
		return 'warning';
	}
	if (session.state === 'draft') return 'neutral';
	return 'info';
}

/* A delivered session reads as delivered, not as an internal state name. */
function stateLabel(session: SandboxSession): string {
	if (session.archivedAt) return 'archived';
	return session.state === 'accepted' ? 'delivered' : session.state;
}

function since(value: number): string {
	const minutes = Math.round((Date.now() - value) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return `${Math.round(hours / 24)} d ago`;
}

export function SessionPicker(props: SessionPickerProps) @{
	const offered = props.drivers.filter((driver) => driver.offered);
	const blocked = props.drivers.filter((driver) => !driver.offered);
	const selected =
		offered.find((driver) => driver.id === props.driver) ?? offered[0] ?? null;
	const archived = props.sessions.filter((session) => session.archivedAt);
	const visible =
		props.showArchived
			? props.sessions
			: props.sessions.filter((session) => !session.archivedAt);

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const brief = form.get('brief');
		if (typeof brief === 'string' && brief.trim().length > 7 && selected) {
			props.onCreate(brief.trim(), selected.id);
		}
	};

	<div class="sessions">
		<header class="sessions__head">
			<h1>What should we build?</h1>
			<p>
				Describe the capability or the change you want on top of the Coreloom
				foundation. The specialists work out which module it belongs to and who
				takes the first turn.
			</p>
		</header>

		<section class="sessions__start">
			<form class="ui-form" onSubmit={submit}>
				<textarea
					class="ui-textarea sessions__brief"
					name="brief"
					rows={4}
					placeholder="A screen where a signed-in user changes their display name and password. Or: add custom roles to auth.core so an owner can define workspace roles."
					required
				></textarea>
				<div class="ui-form__foot">
					<label class="sessions__driver">
						<span class="ui-label">Coding agent</span>
						<select
							class="chat__picker"
							aria-label="Coding agent"
							value={selected?.id ?? ''}
							disabled={offered.length === 0}
							onChange={(event) => props.onDriver(event.currentTarget.value)}
						>
							@for (const driver of offered; key driver.id) {
								<option value={driver.id}>{driver.label}</option>
							}
						</select>
						<span class="ui-help">
							{selected
								? selected.description
								: 'No coding agent is available yet.'}
						</span>
					</label>
					<span class="sandbox__spacer"></span>
					<div class="ui-form__actions">
						<Button
							variant="primary"
							type="submit"
							disabled={props.busy || offered.length === 0}
						>
							<Icon name="play" size={14} />
							{props.busy ? 'Planning…' : 'Start'}
						</Button>
					</div>
				</div>
			</form>
			@if (blocked.length > 0) {
				<ul class="sessions__blocked">
					@for (const driver of blocked; key driver.id) {
						<li>
							<Icon name="alert" size={14} />
							<b>{driver.label}</b>
							<span class="ui-help">
								{driver.blockedReason ?? driver.availability.detail}
							</span>
						</li>
					}
				</ul>
			}
			<p class="ui-help sessions__team">{props.roles.map(
				(role) => role.name,
			).join(' · ')}</p>
		</section>

		@if (props.sessions.length === 0) {
			<EmptyState
				icon="flask"
				title="No session yet"
				code="npx @coreloom/sandbox"
			>
				Describe the work above. Nothing leaves the session until you eject it.
			</EmptyState>
		} @else {
			<>
				@if (archived.length > 0) {
					<div class="sessions__toolbar">
						<span class="ui-help">
							{archived.length === 1
								? '1 archived session'
								: archived.length + ' archived sessions'}
						</span>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => props.onShowArchived(!props.showArchived)}
						>
							{props.showArchived ? 'Hide archived' : 'Show archived'}
						</Button>
					</div>
				}
				<div class="sessions__grid">
					@for (const session of visible; key session.id) {
						<article
							class={[
								'session-card',
								session.archivedAt && 'session-card--archived',
							]}
						>
							<button
								class="session-card__open"
								type="button"
								onClick={() => props.onOpen(session.id)}
							>
								<span class="session-card__title">
									<b>{session.title}</b>
									<small>{session.modules.map((module) => module.id).join(
										', ',
									)}</small>
								</span>
								<span class="session-card__meta">
									<Tag tone={stateTone(session)} dot>{stateLabel(session)}</Tag>
									<small>
										{(session.kind === 'new-module' ? 'new module' : 'change') +
											' · ' +
											session.driver}
									</small>
								</span>
								<span class="session-card__foot">
									<span>
										{props.running.includes(session.id)
											? 'Working now'
											: session.ejectedAt
												? 'Delivered ' + since(session.ejectedAt)
												: 'Updated ' + since(session.updatedAt)}
									</span>
									@if (session.ejectedAt) {
										<Icon name="check" size={14} />
									} @else {
										<Icon name="external" size={14} />
									}
								</span>
							</button>
							<div class="session-card__actions">
								<button
									class="session-card__menu"
									type="button"
									aria-label="Session actions"
									aria-expanded={props.openMenu === session.id}
									onClick={() => props.onMenu(
										props.openMenu === session.id ? '' : session.id,
									)}
								>
									<Icon name="more" size={16} />
								</button>
								@if (props.openMenu === session.id) {
									<div class="ui-menu session-card__panel" role="menu">
										@if (props.confirmDelete === session.id) {
											<>
												<p class="ui-help session-card__confirm">
													{'Delete this session? The workspace and preview data are removed; the transcript stays' +
														(session.ejectedAt
															? ', and the delivered module stays in ' +
																'modules/' +
																session.moduleSuffix +
																'.'
															: '.')}
												</p>
												<div class="ui-form__actions">
													<Button
														size="sm"
														variant="danger"
														disabled={props.busy}
														onClick={() => props.onDelete(session.id)}
													>
														Delete
													</Button>
													<Button
														size="sm"
														variant="ghost"
														onClick={() => props.onConfirmDelete('')}
													>
														Cancel
													</Button>
												</div>
											</>
										} @else {
											<>
												@if (session.archivedAt) {
													<button
														class="ui-menu__item"
														type="button"
														role="menuitem"
														disabled={props.busy}
														onClick={() => props.onRestore(session.id)}
													>
														<Icon name="refresh" size={16} />
														Restore
													</button>
												} @else {
													<button
														class="ui-menu__item"
														type="button"
														role="menuitem"
														disabled={props.busy ||
															props.running.includes(session.id)}
														onClick={() => props.onArchive(session.id)}
													>
														<Icon name="download" size={16} />
														Archive
													</button>
												}
												<div class="ui-menu__sep"></div>
												<button
													class="ui-menu__item ui-menu__item--danger"
													type="button"
													role="menuitem"
													disabled={props.busy ||
														props.running.includes(session.id)}
													onClick={() => props.onConfirmDelete(session.id)}
												>
													<Icon name="x" size={16} />
													{props.running.includes(session.id)
														? 'Delete (stop the turn first)'
														: 'Delete'}
												</button>
											</>
										}
									</div>
								}
							</div>
						</article>
					}
				</div>
			</>
		}
	</div>
}
