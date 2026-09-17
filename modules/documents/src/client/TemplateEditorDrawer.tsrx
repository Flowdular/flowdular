import { useEffect, useMemo, useRef, useState } from 'octane';
import {
	Alert,
	Button,
	CellCode,
	CellTag,
	CellText,
	CellTime,
	ConfirmDialog,
	Drawer,
	EmptyState,
	FormField,
	Icon,
	Select,
	Table,
	Tag,
	toasts,
	type TableAction,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import {
	DOCUMENT_TEMPLATE_FORMATS,
	DOCUMENT_TEMPLATE_LIMITS,
	DOCUMENT_TEMPLATE_PAGE_SIZES,
	type DocumentTemplateFormat,
	type TemplateIssue,
} from '../domain/templates.ts';
import { DocumentsApiError, documentsErrorMessage } from './api.ts';
import { openDownloadTarget } from './download.ts';
import { TemplateBodyField } from './TemplateBodyField.tsrx';
import {
	loadTemplateDetail,
	loadTemplateVersion,
	loadTemplateVersions,
	previewTemplate,
	revertTemplate,
	saveTemplate,
	TemplatesApiError,
	type TemplateDetail,
	type TemplateInputIssue,
	type TemplateVersionSummary,
} from './templates-api.ts';
import {
	draftIssues,
	issueLabel,
	layoutDraft,
	layoutFromDraft,
	lineDiff,
	opensInViewer,
	originLabel,
	originTone,
	parseSampleInput,
	sampleInputText,
	versionLabel,
	type DiffLine,
	type LayoutDraft,
} from './templates-presentation.ts';

export interface TemplateEditorDrawerProps {
	readonly templateKey: string | null;
	readonly csrfToken: string;
	readonly canManage: boolean;
	readonly onClose: () => void;
	/** A new version was kept, so the list reads again. */
	readonly onChanged: () => void;
}

type DetailState = 'loading' | 'idle' | 'error' | 'denied';
type Busy = '' | 'preview' | 'save' | 'revert';
type Confirmation =
	| { readonly kind: 'default' }
	| { readonly kind: 'restore'; readonly version: number };

/* An object URL outlives the preview tab's first paint by this much, then is released. */
const PREVIEW_URL_MS = 60_000;

const EMPTY_LAYOUT: LayoutDraft = {
	pageSize: 'A4',
	top: '',
	right: '',
	bottom: '',
	left: '',
	header: '',
	footer: '',
	title: '',
};

export function TemplateEditorDrawer(props: TemplateEditorDrawerProps) @{
	const [detail, setDetail] = useState<TemplateDetail | null>(null);
	const [state, setState] = useState<DetailState>('loading');
	const [loadError, setLoadError] = useState('');
	const [body, setBody] = useState('');
	const [layout, setLayout] = useState<LayoutDraft>(EMPTY_LAYOUT);
	const [sample, setSample] = useState('');
	const [format, setFormat] = useState<DocumentTemplateFormat>('pdf');
	const [serverIssues, setServerIssues] = useState<
		readonly (TemplateIssue | TemplateInputIssue)[]
	>([]);
	const [actionError, setActionError] = useState('');
	const [busy, setBusy] = useState<Busy>('');
	const [versions, setVersions] = useState<
		readonly TemplateVersionSummary[]
	>([]);
	const [versionsCursor, setVersionsCursor] = useState<string | null>(null);
	const [versionsState, setVersionsState] = useState<DetailState>('loading');
	const [diff, setDiff] = useState<
		{ readonly version: number; readonly lines: readonly DiffLine[] } | null
	>(null);
	const [diffLoading, setDiffLoading] = useState<number | null>(null);
	const [confirm, setConfirm] = useState<Confirmation | null>(null);
	const request = useRef(0);
	const key = props.templateKey;
	const readOnly = !props.canManage || busy !== '';

	const issues = useMemo(
		() => (detail
			? draftIssues(body, layout, detail.current, detail.title)
			: []),
		[detail, body, layout],
	);
	const flagged = useMemo(
		() => new Set([...issues, ...serverIssues].flatMap(
			(issue) => 'line' in issue && issue.line !== null ? [issue.line] : [],
		)),
		[issues, serverIssues],
	);

	const loadVersions = async (templateKey: string, cursor: string | null) => {
		setVersionsState('loading');
		try {
			const page = await loadTemplateVersions(templateKey, cursor);
			setVersions(
				(held) => (cursor === null ? page.items : [...held, ...page.items]),
			);
			setVersionsCursor(page.page.nextCursor);
			setVersionsState('idle');
		} catch (error) {
			setVersionsState(
				error instanceof DocumentsApiError && error.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	/* A slower answer for a template the reader already left is dropped. */
	const load = async (templateKey: string, keepSample: boolean) => {
		const current = ++request.current;
		setState('loading');
		setLoadError('');
		try {
			const loaded = await loadTemplateDetail(templateKey);
			if (current !== request.current) return;
			setDetail(loaded);
			setBody(loaded.current.body);
			setLayout(layoutDraft(loaded.current.layout));
			setFormat(loaded.current.format);
			if (!keepSample) setSample(sampleInputText(loaded.current.inputSchema));
			setServerIssues([]);
			setState('idle');
			void loadVersions(templateKey, null);
		} catch (error) {
			if (current !== request.current) return;
			setLoadError(
				documentsErrorMessage(error, 'documents.templates.error.load'),
			);
			setState(
				error instanceof DocumentsApiError && error.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		request.current += 1;
		setDetail(null);
		setActionError('');
		setDiff(null);
		setConfirm(null);
		setVersions([]);
		setVersionsCursor(null);
		if (key !== null) void load(key, false);
	}, [key]);

	const failed = (error: unknown, fallbackKey: string) => {
		setServerIssues(error instanceof TemplatesApiError ? error.issues : []);
		setActionError(documentsErrorMessage(error, fallbackKey));
	};

	const editBody = (value: string) => {
		setBody(value);
		setServerIssues([]);
	};

	const editLayout = (patch: Partial<LayoutDraft>) => {
		setLayout({ ...layout, ...patch });
		setServerIssues([]);
	};

	const preview = async () => {
		if (!detail) return;
		const input = parseSampleInput(sample);
		if (input.error !== '') {
			setActionError(input.error);
			return;
		}
		setActionError('');
		setServerIssues([]);
		/* The tab is claimed inside the click: one opened after the render
   resolves is a pop-up the browser blocks. A DOCX needs no tab. */
		const tab =
			format === 'pdf' ? openDownloadTarget(window) : null;
		if (format === 'pdf' && !tab) {
			setActionError(t('documents.templates.error.previewBlocked'));
			return;
		}
		setBusy('preview');
		try {
			const file = await previewTemplate(
				{
					key: detail.key,
					body,
					layout: layoutFromDraft(layout),
					input: input.value,
					format,
				},
				props.csrfToken,
			);
			const url = URL.createObjectURL(file.blob);
			if (tab && opensInViewer(file.contentType)) {
				tab.send(url);
			} else {
				tab?.abort();
				const anchor = document.createElement('a');
				anchor.href = url;
				anchor.download = file.filename;
				anchor.rel = 'noopener';
				document.body.append(anchor);
				anchor.click();
				anchor.remove();
			}
			setTimeout(() => URL.revokeObjectURL(url), PREVIEW_URL_MS);
		} catch (error) {
			tab?.abort();
			failed(error, 'documents.templates.error.preview');
		} finally {
			setBusy('');
		}
	};

	const save = async () => {
		if (!detail || issues.length > 0) return;
		setBusy('save');
		setActionError('');
		try {
			const kept = await saveTemplate(
				{
					key: detail.key,
					body,
					layout: layoutFromDraft(layout),
					expectedVersion: detail.current.version ?? 0,
				},
				props.csrfToken,
			);
			toasts.success(
				t('documents.templates.notice.saved', { version: kept.version ?? 0 }),
			);
			props.onChanged();
			await load(detail.key, true);
		} catch (error) {
			failed(error, 'documents.templates.error.save');
		} finally {
			setBusy('');
		}
	};

	const revert = async () => {
		const chosen = confirm;
		setConfirm(null);
		if (!detail || !chosen) return;
		setBusy('revert');
		setActionError('');
		try {
			const kept = await revertTemplate(
				{
					key: detail.key,
					expectedVersion: detail.current.version ?? 0,
					toVersion: chosen.kind === 'restore' ? chosen.version : null,
				},
				props.csrfToken,
			);
			toasts.success(
				chosen.kind === 'restore'
					? t('documents.templates.notice.restored', {
							from: chosen.version,
							version: kept.version ?? 0,
						})
					: t('documents.templates.notice.reverted', {
							version: kept.version ?? 0,
						}),
			);
			props.onChanged();
			setDiff(null);
			await load(detail.key, true);
		} catch (error) {
			failed(error, 'documents.templates.error.revert');
		} finally {
			setBusy('');
		}
	};

	const showDiff = async (version: number) => {
		if (!detail) return;
		if (diff?.version === version) {
			setDiff(null);
			return;
		}
		setDiffLoading(version);
		setActionError('');
		try {
			const [after, before] = await Promise.all([
				loadTemplateVersion(detail.key, version),
				version > 1
					? loadTemplateVersion(detail.key, version - 1)
					: Promise.resolve(null),
			]);
			setDiff({ version, lines: lineDiff(before?.body ?? '', after.body) });
		} catch (error) {
			failed(error, 'documents.templates.error.diff');
		} finally {
			setDiffLoading(null);
		}
	};

	const versionColumns: readonly TableColumn<TemplateVersionSummary>[] = [
		{
			key: 'version',
			header: t('documents.templates.column.version'),
			width: 'auto',
			cell: (entry) => <CellText strong value={versionLabel(entry.version)} />,
		},
		{
			key: 'origin',
			header: t('documents.templates.column.origin'),
			width: '130px',
			cell: (entry) =>
				<CellTag
					tone={originTone(entry.origin)}
					label={originLabel(entry.origin)}
				/>,
		},
		{
			key: 'createdBy',
			header: t('documents.templates.column.createdBy'),
			width: '150px',
			priority: 3,
			cell: (entry) => <CellCode value={entry.createdBy} />,
		},
		{
			key: 'createdAt',
			header: t('documents.templates.column.createdAt'),
			width: '170px',
			priority: 2,
			cell: (entry) => <CellTime value={entry.createdAt} />,
		},
	];

	const versionActions = (
		entry: TemplateVersionSummary,
	): readonly TableAction[] => [
		{
			id: 'diff',
			label: diff?.version === entry.version
				? t('documents.templates.action.hideDiff')
				: t('documents.templates.action.diff'),
			icon: 'file-text',
			disabled: diffLoading !== null,
			onSelect: () => void showDiff(entry.version),
		},
		...(props.canManage
			? [
					{
						id: 'restore',
						label: t('documents.templates.action.restore'),
						icon: 'refresh',
						disabled: busy !== '' || entry.version === detail?.current.version,
						reason: entry.version === detail?.current.version
							? t('documents.templates.action.restoreCurrent')
							: undefined,
						onSelect: () => setConfirm({
							kind: 'restore',
							version: entry.version,
						}),
					},
				]
			: []),
	];

	const allIssues = [...issues, ...serverIssues];

	<>
		<Drawer
			open={key !== null}
			title={detail?.title ?? t('documents.templates.editor.title')}
			subtitle={key ?? t('documents.templates.editor.subtitle')}
			width="lg"
			onClose={props.onClose}
		>
			<div class="ui-drawer__form">
				<div class="ui-drawer__body">
					@if (state === 'denied') {
						<EmptyState
							icon="shield"
							title={t('documents.common.accessDenied')}
						>{t('documents.templates.denied')}</EmptyState>
					} @else if (state === 'error') {
						<div class="ui-form">
							<Alert>{loadError}</Alert>
							<div class="ui-form__actions">
								<Button
									size="sm"
									onClick={() => key !== null && void load(key, false)}
								>
									<Icon name="refresh" size={14} />
									{t('documents.templates.action.tryAgain')}
								</Button>
							</div>
						</div>
					} @else if (state === 'loading' || !detail) {
						<p class="ui-help documents-templates__loading" role="status">{t(
							'documents.templates.editor.loading',
						)}</p>
					} @else {
						<div class="ui-form">
							<section class="ui-form__section">
								<div class="documents-text__summary">
									<Tag tone="neutral">{versionLabel(
										detail.current.version,
									)}</Tag>
									<Tag tone={originTone(detail.current.origin)}>{originLabel(
										detail.current.origin,
									)}</Tag>
									<span class="ui-help ui-mono">{detail.ownerModule}</span>
									<span class="ui-help">{t(
										'documents.templates.editor.formatLocale',
										{
											format: detail.current.format.toUpperCase(),
											locale: detail.current.locale,
										},
									)}</span>
								</div>
								@if (detail.defaultChanged) {
									<Alert tone="info">{t(
										'documents.templates.editor.defaultChanged',
									)}</Alert>
								}
								@if (!props.canManage) {
									<p class="ui-help">{t(
										'documents.templates.editor.readOnly',
									)}</p>
								}
								@if (actionError) {
									<Alert>{actionError}</Alert>
								}
								@if (allIssues.length > 0) {
									<ul class="documents-issues" id="documents-template-issues">
										@for (const [index, issue] of allIssues.entries(); key index) {
											<li class="ui-help ui-help--error">{issueLabel(
												issue,
											)}</li>
										}
									</ul>
								}
							</section>
							<section class="ui-form__section">
								<div class="ui-form__section-head">
									<b>{t('documents.templates.editor.bodyTitle')}</b>
									<small>{t('documents.templates.editor.bodyHelp')}</small>
								</div>
								<TemplateBodyField
									id="documents-template-body"
									label={t('documents.templates.editor.body')}
									value={body}
									disabled={readOnly}
									invalid={flagged.size > 0}
									maxLength={DOCUMENT_TEMPLATE_LIMITS.bodyCharacters}
									flagged={flagged}
									describedBy={allIssues.length > 0
										? 'documents-template-issues'
										: undefined}
									onInput={editBody}
								/>
							</section>
							<section class="ui-form__section">
								<div class="ui-form__section-head">
									<b>{t('documents.templates.editor.layoutTitle')}</b>
									<small>{t('documents.templates.editor.layoutHelp')}</small>
								</div>
								<div class="ui-form__row">
									<Select
										id="documents-template-page-size"
										label={t('documents.templates.editor.pageSize')}
										value={layout.pageSize}
										disabled={readOnly}
										options={DOCUMENT_TEMPLATE_PAGE_SIZES.map(
											(size) => ({ value: size, label: size }),
										)}
										onChange={(value) => editLayout({ pageSize: value })}
									/>
									<FormField
										label={t('documents.templates.editor.titleField')}
										help={t('documents.templates.editor.titleHelp')}
									>
										<input
											class="ui-input"
											value={layout.title}
											maxLength={DOCUMENT_TEMPLATE_LIMITS.lineCharacters}
											disabled={readOnly}
											onInput={(event) => editLayout({
												title: event.currentTarget.value,
											})}
										/>
									</FormField>
								</div>
								<div class="ui-form__row ui-form__row--4">
									@for (const side of [
										'top',
										'right',
										'bottom',
										'left',
									] as const; key side) {
										<FormField
											label={t('documents.templates.editor.margin.' + side)}
										>
											<input
												class="ui-input num"
												type="number"
												inputMode="numeric"
												min={DOCUMENT_TEMPLATE_LIMITS.marginMinMm}
												max={DOCUMENT_TEMPLATE_LIMITS.marginMaxMm}
												value={layout[side]}
												disabled={readOnly}
												onInput={(event) => editLayout({
													[side]: event.currentTarget.value,
												})}
											/>
										</FormField>
									}
								</div>
								<div class="ui-form__row">
									<FormField
										label={t('documents.templates.editor.header')}
										help={t('documents.templates.editor.headerHelp')}
									>
										<input
											class="ui-input"
											value={layout.header}
											maxLength={DOCUMENT_TEMPLATE_LIMITS.lineCharacters}
											disabled={readOnly}
											onInput={(event) => editLayout({
												header: event.currentTarget.value,
											})}
										/>
									</FormField>
									<FormField
										label={t('documents.templates.editor.footer')}
										help={t('documents.templates.editor.footerHelp')}
									>
										<input
											class="ui-input"
											value={layout.footer}
											maxLength={DOCUMENT_TEMPLATE_LIMITS.lineCharacters}
											disabled={readOnly}
											onInput={(event) => editLayout({
												footer: event.currentTarget.value,
											})}
										/>
									</FormField>
								</div>
							</section>
							<section class="ui-form__section">
								<div class="ui-form__section-head">
									<b>{t('documents.templates.editor.schemaTitle')}</b>
									<small>{t('documents.templates.editor.schemaHelp')}</small>
								</div>
								<pre class="ui-code">{JSON.stringify(
									detail.current.inputSchema,
									null,
									2,
								)}</pre>
							</section>
							<section class="ui-form__section">
								<div class="ui-form__section-head">
									<b>{t('documents.templates.editor.previewTitle')}</b>
									<small>{t('documents.templates.editor.previewHelp')}</small>
								</div>
								<FormField label={t('documents.templates.editor.sample')}>
									<textarea
										class="ui-textarea ui-mono"
										rows={8}
										value={sample}
										spellCheck={false}
										maxLength={DOCUMENT_TEMPLATE_LIMITS.inputBytes}
										disabled={busy !== ''}
										onInput={(event) => setSample(event.currentTarget.value)}
									></textarea>
								</FormField>
								<div class="ui-control-row">
									<Select
										id="documents-template-preview-format"
										label={t('documents.templates.editor.previewFormat')}
										value={format}
										options={DOCUMENT_TEMPLATE_FORMATS.map(
											(value) => ({
												value,
												label: t('documents.templates.format.' + value),
											}),
										)}
										disabled={busy !== ''}
										onChange={(value) => setFormat(
											value === 'docx' ? 'docx' : 'pdf',
										)}
									/>
								</div>
								<div class="ui-form__actions">
									<Button
										size="sm"
										disabled={busy !== '' || issues.length > 0}
										onClick={() => void preview()}
									>
										<Icon
											name={format === 'pdf' ? 'external' : 'download'}
											size={14}
										/>
										{busy === 'preview'
											? t('documents.templates.action.previewing')
											: format === 'pdf'
												? t('documents.templates.action.previewPdf')
												: t('documents.templates.action.previewDocx')}
									</Button>
								</div>
							</section>
							<section class="ui-form__section">
								<div class="ui-form__section-head">
									<b>{t('documents.templates.editor.historyTitle')}</b>
									<small>{t('documents.templates.editor.historyHelp')}</small>
								</div>
								<Table
									caption={t('documents.templates.editor.historyCaption')}
									columns={versionColumns}
									rows={versions}
									rowKey={(entry) => String(entry.version)}
									status={versionsState === 'loading' && versions.length === 0
										? 'loading'
										: 'idle'}
									loadingLabel={t('documents.templates.editor.historyLoading')}
									empty={versionsState === 'error' || versionsState === 'denied'
										? {
												icon: 'alert',
												title: t('documents.templates.editor.historyFailed'),
											}
										: {
												icon: 'file-text',
												title: t('documents.templates.editor.historyEmpty'),
												hint: t('documents.templates.editor.historyEmptyHint'),
											}}
									actions={versionActions}
									actionsLabel={t('documents.common.actions')}
									actionsWidth="200px"
								/>
								@if (versionsCursor !== null) {
									<div class="ui-form__actions">
										<Button
											size="sm"
											disabled={versionsState === 'loading'}
											onClick={() => void loadVersions(
												detail.key,
												versionsCursor,
											)}
										>{t('documents.action.more')}</Button>
									</div>
								}
								@if (diffLoading !== null) {
									<p class="ui-help" role="status">{t(
										'documents.templates.diff.loading',
									)}</p>
								}
								@if (diff) {
									<div class="documents-diff">
										<b class="ui-label">
											{diff.version === 1
												? t('documents.templates.diff.first')
												: t('documents.templates.diff.title', {
														version: diff.version,
														previous: diff.version - 1,
													})}
										</b>
										@if (diff.lines.every((line) => line.kind === 'same')) {
											<p class="ui-help">{t(
												'documents.templates.diff.bodySame',
											)}</p>
										} @else {
											<pre class="documents-diff__body">
												@for (const [index, line] of diff.lines.entries(); key index) {
													<span
														class={[
															'documents-diff__line',
															'documents-diff__line--' + line.kind,
														]}
													>
														<span
															class="documents-diff__mark"
															aria-label={t(
																'documents.templates.diff.' + line.kind,
															)}
														>
															{line.kind === 'added'
																? '+'
																: line.kind === 'removed'
																	? '-'
																	: ' '}
														</span>
														{line.text}
													</span>
												}
											</pre>
										}
									</div>
								}
							</section>
							@if (props.canManage) {
								<section class="ui-form__section ui-form__section--danger">
									<div class="ui-form__section-head">
										<b>{t('documents.templates.revert.title')}</b>
										<small>{t('documents.templates.revert.description')}</small>
									</div>
									<Button
										variant="danger"
										size="sm"
										disabled={busy !== ''}
										onClick={() => setConfirm({ kind: 'default' })}
									>{t('documents.templates.action.revert')}</Button>
								</section>
							}
						</div>
					}
				</div>
				<div class="ui-drawer__foot">
					<small>{t('documents.templates.editor.constraint')}</small>
					<div class="ui-form__actions">
						<Button onClick={props.onClose}>{t(
							'documents.common.close',
						)}</Button>
						@if (props.canManage && detail && state === 'idle') {
							<Button
								variant="primary"
								disabled={busy !== '' || issues.length > 0}
								onClick={() => void save()}
							>
								{busy === 'save'
									? t('documents.templates.action.saving')
									: t('documents.templates.action.save')}
							</Button>
						}
					</div>
				</div>
			</div>
		</Drawer>
		<ConfirmDialog
			open={confirm !== null}
			title={confirm?.kind === 'restore'
				? t('documents.templates.restore.confirmTitle', {
						version: confirm.version,
					})
				: t('documents.templates.revert.confirmTitle')}
			confirmLabel={confirm?.kind === 'restore'
				? t('documents.templates.action.restore')
				: t('documents.templates.action.revert')}
			tone={confirm?.kind === 'restore' ? 'primary' : 'danger'}
			busy={busy === 'revert'}
			onConfirm={() => void revert()}
			onCancel={() => setConfirm(null)}
		>
			{confirm?.kind === 'restore'
				? t('documents.templates.restore.confirmDescription', {
						version: confirm.version,
					})
				: t('documents.templates.revert.confirmDescription')}
		</ConfirmDialog>
	</>
}
