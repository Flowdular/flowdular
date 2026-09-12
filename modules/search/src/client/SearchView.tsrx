import { useEffect, useMemo, useRef } from 'octane';
import { applicationPath, t } from '@flowdular/client';
import {
	Alert,
	Button,
	EmptyState,
	Filters,
	Icon,
	PageHeader,
	SearchField,
	Select,
	TableCard,
	Tag,
	type TableColumn,
} from '@flowdular/ui';
import { useValue } from 'segment-state';
import { SEARCH_LIMITS, type SearchResultHit } from '../domain/types.ts';
import {
	clearRecentQueries,
	loadRecentQueries,
	rememberQuery,
	searchErrorMessage,
	searchRecords,
	SearchApiError,
} from './api.ts';
import { workspaceRouteHref } from './navigation.ts';
import {
	answerIsCurrent,
	applyPage,
	clearResults,
	createSearchClientState,
	providerLabels,
} from './state.ts';

export interface SearchViewProps {
	readonly csrfToken: string;
}

/** Same wait as the palette, so typing behaves the same in both places. */
const DEBOUNCE_MS = 200;

function columns(
	labels: ReadonlyMap<string, string>,
	pathname: string,
	onOpen: () => void,
): readonly TableColumn<SearchResultHit>[] {
	return [
		{
			key: 'title',
			header: t('search.table.column.record'),
			width: '58%',
			value: (hit) => hit.title,
			cell: (hit) => <a
				class="search-hit"
				href={workspaceRouteHref(hit.route, pathname, applicationPath())}
				onClick={onOpen}
			>
				<b>{hit.title}</b>
				<small class="ui-cell__muted">{hit.snippet}</small>
			</a>,
		},
		{
			key: 'provider',
			header: t('search.table.column.provider'),
			width: '42%',
			value: (hit) => labels.get(hit.provider) ?? hit.provider,
			cell: (hit) => <Tag>{labels.get(hit.provider) ?? hit.provider}</Tag>,
		},
	];
}

export function SearchView(props: SearchViewProps) @{
	const client = useMemo(() => createSearchClientState(), []);
	const [hits] = useValue(client.state.hits);
	const [providers] = useValue(client.state.providers);
	const [unavailable] = useValue(client.state.unavailable);
	const [recent] = useValue(client.state.recent);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [providerFilter, setProviderFilter] = useValue(
		client.state.providerFilter,
	);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [searched] = useValue(client.state.searched);
	const [nextCursor] = useValue(client.state.nextCursor);
	const latest = useRef(0);
	const labels = providerLabels(providers);
	const pathname =
		typeof window === 'undefined'
			? applicationPath()
			: window.location.pathname;
	const tooShort =
		query.trim().length > 0 && query.trim().length < SEARCH_LIMITS.queryMinimum;

	const run = async (
		term: string,
		provider: string,
		options: { readonly cursor?: string; readonly remember?: boolean } = {},
	) => {
		/* Debounced typing, a filter change and a load-more overlap, and the
   answers can arrive in any order: only the newest request answering the term
   the box still holds may write, so neither a slow earlier one nor one whose
   term the member has already deleted puts its hits back on screen. */
		const ticket = latest.current += 1;
		setStatus('loading');
		setError('');
		try {
			const page = await searchRecords({
				query: term,
				...(provider === '' ? {} : { provider }),
				...(options.cursor === undefined ? {} : { cursor: options.cursor }),
				...(options.remember === true ? { remember: true } : {}),
			});
			if (!answerIsCurrent(client, term, ticket, latest)) return;
			applyPage(client, page, {
				term,
				append: options.cursor !== undefined,
			});
		} catch (searchError) {
			if (!answerIsCurrent(client, term, ticket, latest)) return;
			setError(searchErrorMessage(searchError, 'search.error.load'));
			setStatus(
				searchError instanceof SearchApiError && searchError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	const refreshRecent = async () => {
		try {
			client.store.set(
				client.state.recent,
				await loadRecentQueries(),
				'search/recent-loaded',
			);
		} catch {
			/* Recall is a convenience: a refused or failed list never keeps the
   member from searching. */
		}
	};

	const clearRecent = async () => {
		setStatus('submitting');
		try {
			await clearRecentQueries(props.csrfToken);
			client.store.act((transaction) => {
				transaction.set(client.state.recent, []);
				transaction.set(client.state.status, 'idle');
			}, 'search/recent-cleared');
		} catch (clearError) {
			setError(searchErrorMessage(clearError, 'search.error.clearRecent'));
			setStatus('error');
		}
	};

	/* The provider list is part of the answer, so an empty query is still sent
   once: it returns no hits and the filter options the screen needs. */
	useEffect(() => {
		void run('', '');
		void refreshRecent();
	}, []);

	useEffect(() => {
		const term = query.trim();
		if (term.length < SEARCH_LIMITS.queryMinimum) {
			if (hits.length > 0 || searched) clearResults(client);
			return;
		}
		const timer = setTimeout(() => void run(term, providerFilter), DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query, providerFilter]);

	/* Typing is not a search the member meant to keep: a deliberate submit and
   opening a hit are, so those two are what asks the server to remember. */
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const term = query.trim();
		if (term.length < SEARCH_LIMITS.queryMinimum) return;
		void run(term, providerFilter, { remember: true });
	};

	/* Opening a record is the member saying the query was the right one. The
   screen is navigating away, so recall is asked for by its own keepalive write
   the browser finishes without it, not by a second search whose answer this
   view would no longer be there to read. A refused or failed write never
   interferes with the navigation the click started. */
	const openedHit = () => {
		const term = query.trim();
		if (term.length < SEARCH_LIMITS.queryMinimum) return;
		rememberQuery(term, props.csrfToken).catch(() => undefined);
	};

	const loadMore = () => {
		if (nextCursor === null) return;
		void run(query.trim(), providerFilter, { cursor: nextCursor });
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('search.page.eyebrow')}
			title={t('search.page.title')}
			description={t('search.page.description')}
		>
			<Button
				size="sm"
				disabled={status === 'denied'}
				onClick={() => void run(query.trim(), providerFilter, {
					remember: true,
				})}
			>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('search.action.searching')
					: t('search.action.search')}
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('search.denied.title')}>{t(
					'search.denied.hint',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error) {
					<Alert>{error}</Alert>
				}
				@if (unavailable.length > 0) {
					<Alert tone="warning">{t('search.notice.unavailable', {
						providers: unavailable.map((key) => labels.get(key) ?? key).join(
							', ',
						),
					})}</Alert>
				}
				@if (recent.length > 0) {
					<section class="ui-card search-recent">
						<div class="ui-card__head">
							<span class="ui-card__title">
								{t('search.recent.title')}
								<small>{t('search.recent.count', {
									count: recent.length,
								})}</small>
							</span>
							<div class="ui-card__actions">
								<Button
									size="sm"
									variant="ghost"
									disabled={status === 'submitting'}
									onClick={() => void clearRecent()}
								>{t('search.recent.clear')}</Button>
							</div>
						</div>
						<div class="search-recent__list">
							@for (const entry of recent; key entry.query) {
								<button
									class="search-recent__item"
									type="button"
									onClick={() => setQuery(entry.query)}
								>{entry.query}</button>
							}
						</div>
					</section>
				}
				<TableCard
					title={t('search.table.title')}
					count={t('search.table.count', { count: hits.length })}
					caption={t('search.table.caption')}
					search={<form class="search-submit" onSubmit={submit}>
						<SearchField
							value={query}
							placeholder={t('search.search.placeholder')}
							label={t('search.search.label')}
							onInput={(value) => setQuery(value)}
						/>
					</form>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={providerFilter === '' ? 0 : 1}
						label={t('search.common.filters')}
					>
						<Select
							id="search-provider"
							label={t('search.filter.provider')}
							value={providerFilter}
							options={[
								{ value: '', label: t('search.filter.allProviders') },
								...providers.map(
									(provider) => ({
										value: provider.key,
										label: provider.label + ' · ' + provider.moduleId,
									}),
								),
							]}
							onChange={(value) => {
								setProviderFilter(value);
								if (query.trim().length >= SEARCH_LIMITS.queryMinimum) {
									void run(query.trim(), value);
								}
							}}
						/>
					</Filters>}
					columns={columns(labels, pathname, openedHit)}
					rows={hits}
					rowKey={(hit) => hit.provider + ':' + hit.ref}
					status={status === 'loading' && hits.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('search.table.loading')}
					filtered={searched}
					empty={{
						icon: 'search',
						title: t('search.table.emptyTitle'),
						hint: tooShort
							? t('search.table.tooShort', {
									count: SEARCH_LIMITS.queryMinimum,
								})
							: t('search.table.emptyHint'),
					}}
					emptyFiltered={{
						icon: 'search',
						title: t('search.table.noMatchTitle'),
						hint: t('search.table.noMatchHint', { query: query.trim() }),
					}}
					after={nextCursor === null
						? null
						: <div class="search-more">
								<Button
									size="sm"
									variant="ghost"
									disabled={status === 'loading'}
									onClick={loadMore}
								>
									{status === 'loading'
										? t('search.action.loadingMore')
										: t('search.action.loadMore')}
								</Button>
							</div>}
					note={t('search.table.note')}
				/>
			</>
		}
	</div>
}
