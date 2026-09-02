import { useEffect, useRef, useState } from 'octane';
import { Button, EmptyState, Icon, Tag } from '@coreloom/ui';
import type { SandboxSession } from '../server/sessions.ts';
import type { DriverSummary, RoleSummary } from './api.ts';
import {
	ATTACH_ACCEPT,
	attachmentKind,
	attachmentRefusal,
	formatBytes,
} from './attachments.ts';
import { t, useTranslation } from './i18n.ts';

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
	readonly onCreate: (brief: string, driver: string, attachments: readonly File[]) => void;
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
	if (session.archivedAt) return t('sandbox.sessions.state.archived');
	return session.state === 'accepted'
		? t('sandbox.sessions.state.delivered')
		: t('sandbox.session.state.' + session.state);
}

/* A file the operator attached before the session exists. It is uploaded to
   the new session id right after the session is created. */
interface PickedFile {
	readonly key: string;
	readonly file: File;
	readonly kind: 'image' | 'file';
	/* Object URL for an image thumbnail, empty otherwise. Revoked on removal
   and when the screen goes away. */
	readonly url: string;
}

/* Every module of the session, bounded so a card stays a card. */
function moduleLine(session: SandboxSession): string {
	const ids = session.modules.map((module) => module.id);
	return ids.length > 2
		? `${ids[0]}, ${ids[1]} +${ids.length - 2}`
		: ids.join(', ');
}

function since(value: number): string {
	const minutes = Math.round((Date.now() - value) / 60_000);
	if (minutes < 1) return t('sandbox.sessions.time.now');
	if (minutes < 60) return t('sandbox.sessions.time.minutes', {
		count: minutes,
	});
	const hours = Math.round(minutes / 60);
	if (hours < 24) return t('sandbox.sessions.time.hours', { count: hours });
	return t('sandbox.sessions.time.days', { count: Math.round(hours / 24) });
}

export function SessionPicker(props: SessionPickerProps) @{
	const { t } = useTranslation();
	const offered = props.drivers.filter((driver) => driver.offered);
	const blocked = props.drivers.filter((driver) => !driver.offered);
	const selected =
		offered.find((driver) => driver.id === props.driver) ?? offered[0] ?? null;
	const archived = props.sessions.filter((session) => session.archivedAt);
	const visible =
		props.showArchived
			? props.sessions
			: props.sessions.filter((session) => !session.archivedAt);
	const attachInput = useRef<HTMLInputElement | null>(null);
	const opened = useRef<string[]>([]);
	const [picked, setPicked] = useState<readonly PickedFile[]>([]);
	const [attachError, setAttachError] = useState('');

	/* Thumbnails hold object URLs; nothing else releases them, so the screen
   does it when it goes away. */
	useEffect(
		() => () => {
			for (const url of opened.current) URL.revokeObjectURL(url);
		},
		[],
	);

	const addFiles = (chosen: readonly File[]) => {
		const next = [...picked];
		let refusal = '';
		for (const file of chosen) {
			const reason = attachmentRefusal(file, next.length);
			if (reason) {
				refusal = reason;
				continue;
			}
			const kind = attachmentKind(file);
			const url =
				kind === 'image' ? URL.createObjectURL(file) : '';
			if (url) opened.current.push(url);
			next.push({
				key: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(
					2,
					8,
				)}`,
				file,
				kind,
				url,
			});
		}
		setPicked(next);
		setAttachError(refusal);
	};

	const removeFile = (key: string) => {
		const found = picked.find((item) => item.key === key);
		if (found?.url) URL.revokeObjectURL(found.url);
		setPicked(picked.filter((item) => item.key !== key));
	};

	const onPaste = (event: ClipboardEvent) => {
		const files = event.clipboardData?.files;
		if (!files || files.length === 0) return;
		const images = Array.from(files).filter(
			(file) => file.type.startsWith('image/'),
		);
		if (images.length === 0) return;
		event.preventDefault();
		addFiles(images);
	};

	const onPick = (event: Event & { currentTarget: HTMLInputElement }) => {
		const chosen = event.currentTarget.files;
		if (chosen && chosen.length > 0) addFiles(Array.from(chosen));
		event.currentTarget.value = '';
	};

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const brief = form.get('brief');
		if (typeof brief === 'string' && brief.trim().length > 7 && selected) {
			props.onCreate(
				brief.trim(),
				selected.id,
				picked.map((item) => item.file),
			);
		}
	};

	<div class="sessions">
		<header class="sessions__head">
			<h1>{t('sandbox.sessions.title')}</h1>
			<p>{t('sandbox.sessions.description')}</p>
		</header>

		<section class="sessions__start">
			<form class="sessions__composer" onSubmit={submit}>
				@if (picked.length > 0 || attachError) {
					<div class="chat__attachments">
						@for (const item of picked; key item.key) {
							<div class="chat__attachment">
								@if (item.kind === 'image') {
									<img
										class="chat__attachment-thumb"
										src={item.url}
										alt={item.file.name}
									/>
								} @else {
									<span
										class="chat__attachment-thumb chat__attachment-thumb--file"
									>
										<Icon name="file-text" size={18} />
									</span>
								}
								<span class="chat__attachment-info">
									<span class="chat__attachment-name">{item.file.name}</span>
									<span class="chat__attachment-size">{formatBytes(
										item.file.size,
									)}</span>
								</span>
								<button
									class="chat__attachment-remove"
									type="button"
									aria-label={t('sandbox.attachments.remove', {
										name: item.file.name,
									})}
									onClick={() => removeFile(item.key)}
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
					class="ui-textarea sessions__brief"
					name="brief"
					rows={4}
					placeholder={t('sandbox.sessions.brief.placeholder')}
					required
					onPaste={onPaste}
				></textarea>
				<div class="sessions__composer-row">
					<button
						class="chat__attach"
						type="button"
						aria-label={t('sandbox.attachments.action')}
						title={t('sandbox.attachments.help')}
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
						aria-label={t('sandbox.sessions.driver.label')}
						value={selected?.id ?? ''}
						disabled={offered.length === 0}
						onChange={(event) => props.onDriver(event.currentTarget.value)}
					>
						@for (const driver of offered; key driver.id) {
							<option value={driver.id}>{driver.label}</option>
						}
					</select>
					<span class="sandbox__spacer"></span>
					<Button
						size="sm"
						variant="primary"
						type="submit"
						disabled={props.busy || offered.length === 0}
					>
						<Icon name="play" size={14} />
						{props.busy
							? t('sandbox.sessions.planning')
							: t('sandbox.sessions.start')}
					</Button>
				</div>
				<p class="chat__composer-status">
					{selected ? selected.description : t('sandbox.sessions.driver.none')}
				</p>
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
		</section>

		@if (props.sessions.length === 0) {
			<EmptyState
				icon="flask"
				title={t('sandbox.sessions.empty.title')}
				code="npx @coreloom/sandbox"
			>{t('sandbox.sessions.empty.description')}</EmptyState>
		} @else {
			<>
				@if (archived.length > 0) {
					<div class="sessions__toolbar">
						<span class="ui-help">
							{archived.length === 1
								? t('sandbox.sessions.archived.one')
								: t('sandbox.sessions.archived.other', {
										count: archived.length,
									})}
						</span>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => props.onShowArchived(!props.showArchived)}
						>
							{props.showArchived
								? t('sandbox.sessions.archived.hide')
								: t('sandbox.sessions.archived.show')}
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
									<small>{moduleLine(session)}</small>
								</span>
								<span class="session-card__meta">
									<Tag tone={stateTone(session)} dot>{stateLabel(session)}</Tag>
									<small>{t('sandbox.sessions.kindAndDriver', {
										kind: session.kind === 'new-module'
											? t('sandbox.sessions.kind.new')
											: t('sandbox.sessions.kind.change'),
										driver: session.driver,
									})}</small>
								</span>
								<span class="session-card__foot">
									<span>
										{props.running.includes(session.id)
											? t('sandbox.sessions.working')
											: session.ejectedAt
												? t('sandbox.sessions.deliveredAt', {
														when: since(session.ejectedAt),
													})
												: t('sandbox.sessions.updatedAt', {
														when: since(session.updatedAt),
													})}
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
									aria-label={t('sandbox.sessions.actions')}
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
												<p class="ui-help session-card__confirm">{t(
													'sandbox.sessions.delete.confirm',
													{
														delivery: session.ejectedAt
															? t('sandbox.sessions.delete.delivered', {
																	paths: session.modules.map(
																		(module) => 'modules/' + module.directory,
																	).join(', '),
																})
															: '',
													},
												)}</p>
												<div class="ui-form__actions">
													<Button
														size="sm"
														variant="danger"
														disabled={props.busy}
														onClick={() => props.onDelete(session.id)}
													>{t('sandbox.common.delete')}</Button>
													<Button
														size="sm"
														variant="ghost"
														onClick={() => props.onConfirmDelete('')}
													>{t('sandbox.common.cancel')}</Button>
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
														{t('sandbox.common.restore')}
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
														{t('sandbox.sessions.archive')}
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
														? t('sandbox.sessions.delete.stopFirst')
														: t('sandbox.common.delete')}
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
