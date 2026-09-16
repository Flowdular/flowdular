import { useEffect, useRef, useState } from 'octane';
import {
	Alert,
	Button,
	Drawer,
	EmptyState,
	Icon,
	Tabs,
	Tag,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import type { DocumentAttachment } from '../domain/attachments.ts';
import {
	DocumentsApiError,
	documentsErrorMessage,
	loadDocumentText,
	retryDocumentText,
	type DocumentTextAnswer,
} from './api.ts';
import {
	byteLabel,
	scanLabel,
	scanTone,
	textPageList,
	textReasonLabel,
	textRetryable,
	textStatusLabel,
	textStatusTone,
	timestampLabel,
} from './presentation.ts';

export interface DocumentDetailsDrawerProps {
	readonly document: DocumentAttachment | null;
	readonly csrfToken: string;
	readonly canManage: boolean;
	readonly onClose: () => void;
}

/** Pages one read of the Text tab asks for. */
const PAGE_WINDOW = 10;
/** How long a pending extraction waits before the tab reads it again. */
const PENDING_POLL_MS = 3_000;

type DetailsTab = 'details' | 'text';
type TextState = 'idle' | 'loading' | 'error' | 'denied';

export function DocumentDetailsDrawer(props: DocumentDetailsDrawerProps) @{
	const [tab, setTab] = useState<DetailsTab>('details');
	const [text, setText] = useState<DocumentTextAnswer | null>(null);
	const [textState, setTextState] = useState<TextState>('idle');
	const [error, setError] = useState('');
	const [from, setFrom] = useState(1);
	const [retrying, setRetrying] = useState(false);
	const [retryError, setRetryError] = useState('');
	const request = useRef(0);
	const record = props.document;

	/* A slower answer for a document or a page window the reader already left
   is dropped, so the tab never shows text of another request. */
	const load = async (id: string, first: number) => {
		const current = ++request.current;
		setTextState('loading');
		setError('');
		try {
			const answer = await loadDocumentText(
				id,
				{ from: first, to: first + PAGE_WINDOW - 1 },
				props.csrfToken,
			);
			if (current !== request.current) return;
			setText(answer);
			setTextState('idle');
		} catch (loadError) {
			if (current !== request.current) return;
			setError(documentsErrorMessage(loadError, 'documents.text.error.load'));
			setTextState(
				loadError instanceof DocumentsApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		request.current += 1;
		setTab('details');
		setText(null);
		setTextState('idle');
		setError('');
		setFrom(1);
		setRetryError('');
	}, [record?.id]);

	useEffect(() => {
		if (!record || tab !== 'text') return;
		void load(record.id, from);
	}, [tab, record?.id, from]);

	useEffect(() => {
		if (!record || tab !== 'text' || text?.status !== 'pending') return;
		const timer = setTimeout(() => void load(record.id, from), PENDING_POLL_MS);
		return () => clearTimeout(timer);
	}, [tab, record?.id, text]);

	const retry = async () => {
		if (!record) return;
		setRetrying(true);
		setRetryError('');
		try {
			const answer = await retryDocumentText(record.id, props.csrfToken);
			request.current += 1;
			setText(answer);
			setTextState('idle');
		} catch (retryFailure) {
			setRetryError(
				documentsErrorMessage(retryFailure, 'documents.text.error.retry'),
			);
		} finally {
			setRetrying(false);
		}
	};

	<Drawer
		open={record !== null}
		title={record?.filename ?? t('documents.details.title')}
		subtitle={t('documents.details.subtitle')}
		width="lg"
		onClose={props.onClose}
	>
		<div class="ui-drawer__body">
			@if (record) {
				<div class="ui-form">
					<Tabs
						id="documents-details"
						items={[
							{ id: 'details', label: t('documents.details.tab.details') },
							{ id: 'text', label: t('documents.details.tab.text') },
						]}
						active={tab}
						onChange={(next) => setTab(next === 'text' ? 'text' : 'details')}
						label={t('documents.details.tabsLabel')}
					/>
					<div
						id={'documents-details-panel-' + tab}
						role="tabpanel"
						aria-labelledby={'documents-details-tab-' + tab}
						class="documents-details__panel"
					>
						@if (tab === 'details') {
							<dl class="documents-facts">
								<dt>{t('documents.column.contentType')}</dt>
								<dd>
									<span class="ui-mono">{record.contentType}</span>
								</dd>
								<dt>{t('documents.column.bytes')}</dt>
								<dd>{byteLabel(record.bytes)}</dd>
								<dt>{t('documents.column.scan')}</dt>
								<dd>
									<Tag tone={scanTone(record.scan)} dot>{scanLabel(
										record.scan,
									)}</Tag>
								</dd>
								<dt>{t('documents.column.ownerModule')}</dt>
								<dd>
									<span class="ui-mono">{record.ownerModule}</span>
								</dd>
								<dt>{t('documents.column.recordRef')}</dt>
								<dd>
									<span class="ui-mono">{record.recordRef}</span>
								</dd>
								<dt>{t('documents.column.uploader')}</dt>
								<dd>
									<span class="ui-mono">{record.uploaderAccountId}</span>
								</dd>
								<dt>{t('documents.details.uploadedAt')}</dt>
								<dd>{timestampLabel(record.createdAt)}</dd>
								<dt>{t('documents.details.description')}</dt>
								<dd>{record.description ?? t('documents.details.none')}</dd>
								<dt>{t('documents.details.checksum')}</dt>
								<dd>
									<span class="ui-mono">
										{record.checksum ?? t('documents.details.none')}
									</span>
								</dd>
							</dl>
						} @else if (textState === 'denied') {
							<EmptyState
								icon="shield"
								title={t('documents.common.accessDenied')}
							>{t('documents.text.denied')}</EmptyState>
						} @else if (textState === 'error') {
							<>
								<Alert>{error}</Alert>
								<div class="ui-form__actions">
									<Button size="sm" onClick={() => void load(record.id, from)}>
										<Icon name="refresh" size={14} />
										{t('documents.text.tryAgain')}
									</Button>
								</div>
							</>
						} @else if (text === null) {
							<p class="ui-help" role="status">{t('documents.text.loading')}</p>
						} @else {
							<>
								<div class="documents-text__summary">
									<Tag tone={textStatusTone(text.status)} dot>{textStatusLabel(
										text.status,
									)}</Tag>
									@if (text.pages > 0) {
										<span class="ui-help">{t('documents.text.pages', {
											count: text.pages,
										})}</span>
									}
									@if (text.truncated) {
										<span class="ui-help">{t('documents.text.truncated')}</span>
									}
								</div>
								@if (text.reason !== null) {
									<p class="ui-help">{textReasonLabel(text.reason)}</p>
								}
								@if (retryError) {
									<Alert>{retryError}</Alert>
								}
								@if (text.status === 'pending') {
									<p class="ui-help" role="status">{t(
										'documents.text.pendingHint',
									)}</p>
								} @else if (textRetryable(text, props.canManage)) {
									<div class="ui-form__actions">
										<Button
											size="sm"
											disabled={retrying}
											onClick={() => void retry()}
										>
											<Icon name="refresh" size={14} />
											{retrying
												? t('documents.text.retrying')
												: t('documents.text.retry')}
										</Button>
									</div>
								}
								@if (text.status === 'ok') {
									<>
										@if (
											textPageList(text).every(
												(page) => page.text.trim() === '',
											)
										) {
											<EmptyState
												icon="file-text"
												title={t('documents.text.empty.title')}
											>{t('documents.text.empty.hint')}</EmptyState>
										} @else {
											@for (const page of textPageList(text); key page.number) {
												<section class="documents-text__page">
													<h3 class="ui-label">{t('documents.text.page', {
														number: page.number,
													})}</h3>
													<pre class="documents-text__body">{page.text}</pre>
												</section>
											}
										}
										<div class="ui-form__actions">
											<Button
												size="sm"
												disabled={from === 1 || textState === 'loading'}
												onClick={() => setFrom(Math.max(1, from - PAGE_WINDOW))}
											>{t('documents.text.previous')}</Button>
											<Button
												size="sm"
												disabled={text.to < from + PAGE_WINDOW - 1 ||
													text.to >= text.pages ||
													textState === 'loading'}
												onClick={() => setFrom(from + PAGE_WINDOW)}
											>{t('documents.text.next')}</Button>
										</div>
									</>
								}
							</>
						}
					</div>
				</div>
			}
		</div>
	</Drawer>
}
