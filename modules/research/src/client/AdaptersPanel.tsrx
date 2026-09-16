import { useEffect, useRef, useState } from 'octane';
import {
	Alert,
	Button,
	EmptyState,
	FormField,
	Select,
	SortableList,
	Switch,
	Tag,
	type SortableAnnouncement,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import type {
	ResearchAdaptersOverview,
	ResearchAdapterView,
	ResearchReliability,
} from '../domain/types.ts';
import { AdapterDrawer } from './AdapterDrawer.tsrx';
import {
	loadAdapters,
	ResearchApiError,
	researchErrorMessage,
	saveChainSettings,
	type ResearchChainSettingsChange,
} from './api.ts';
import {
	adapterLabel,
	adapterStatusLabel,
	adapterStatusTone,
	errorCodeLabel,
} from './presentation.ts';

export interface AdaptersPanelProps {
	readonly csrfToken: string;
	/** Bumped by the view's refresh button. */
	readonly reloadKey: number;
}

interface AdapterItem {
	readonly id: string;
	readonly label: string;
	readonly view: ResearchAdapterView;
}

function items(views: readonly ResearchAdapterView[]): readonly AdapterItem[] {
	return views.map(
		(view) => ({
			id: view.key,
			label: adapterLabel(view.key),
			view,
		}),
	);
}

function announce(event: SortableAnnouncement): string {
	return t('research.adapters.announce.' + event.kind, {
		label: event.label,
		position: event.position,
		total: event.total,
	});
}

function numberInput(value: string): number {
	return value.trim() === '' ? Number.NaN : Number(value);
}

export function AdaptersPanel(props: AdaptersPanelProps) @{
	const [overview, setOverview] = useState<ResearchAdaptersOverview | null>(
		null,
	);
	const [status, setStatus] = useState<'loading' | 'idle' | 'error' | 'denied'>(
		'loading',
	);
	const [error, setError] = useState('');
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState('');
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState<ResearchReliability | null>(null);
	const [backoff, setBackoff] = useState('');
	const [threshold, setThreshold] = useState('');
	const [cooldown, setCooldown] = useState('');
	const [reliabilityError, setReliabilityError] = useState('');

	const accept = (next: ResearchAdaptersOverview) => {
		setOverview(next);
		setDraft(next.reliability);
		setBackoff(String(next.reliability.retryBackoffMs));
		setThreshold(String(next.reliability.circuitFailureThreshold));
		setCooldown(String(next.reliability.circuitCooldownMs));
	};

	const saves = useRef(0);

	/* Only a missing permission is the denied state; a refused session proof
   is a save error the reader can retry. */
	const permissionDenied = (failure: unknown) =>
		failure instanceof ResearchApiError && failure.status === 403 &&
			(failure.code === 'FORBIDDEN' || failure.code === 'MODULE_INACTIVE');

	const refused = (failure: unknown, fallbackKey: string): string => {
		if (permissionDenied(failure)) setStatus('denied');
		return researchErrorMessage(failure, fallbackKey);
	};

	const load = async () => {
		setStatus('loading');
		setError('');
		try {
			accept(await loadAdapters());
			setStatus('idle');
		} catch (failure) {
			setError(refused(failure, 'research.adapters.error.load'));
			if (!permissionDenied(failure)) setStatus('error');
		}
	};

	useEffect(() => {
		void load();
	}, [props.reloadKey]);

	const save = async (
		change: ResearchChainSettingsChange,
		optimistic?: ResearchAdaptersOverview,
	) => {
		/* The grips and switches stay enabled while a change saves, so keyboard
   focus is never dropped; only the newest save's answer is applied. */
		const previous = overview;
		const sequence = ++saves.current;
		if (optimistic) setOverview(optimistic);
		setSaving(true);
		setSaveError('');
		try {
			const saved = await saveChainSettings(props.csrfToken, change);
			if (sequence === saves.current) accept(saved);
		} catch (failure) {
			if (sequence !== saves.current) return;
			if (previous) setOverview(previous);
			setSaveError(refused(failure, 'research.adapters.error.save'));
		} finally {
			if (sequence === saves.current) setSaving(false);
		}
	};

	const enabledMap = (views: readonly ResearchAdapterView[]) =>
		Object.fromEntries(views.map((view) => [view.key, view.enabled]));

	const reorderSearch = (ids: readonly string[]) => {
		if (!overview) return;
		const search = ids.map(
			(id) => overview.search.find((view) => view.key === id)!,
		);
		void save({ searchOrder: ids, enabled: enabledMap(overview.search) }, {
			...overview,
			search,
		});
	};

	const toggleSearch = (key: string, enabled: boolean) => {
		if (!overview) return;
		const search = overview.search.map(
			(view) => view.key === key ? { ...view, enabled } : view,
		);
		void save(
			{
				searchOrder: search.map((view) => view.key),
				enabled: enabledMap(search),
			},
			{ ...overview, search },
		);
	};

	const fetchIds = (views: readonly ResearchAdapterView[]) => views.filter(
		(view) => view.enabled,
	).map((view) => view.key);

	const reorderFetch = (ids: readonly string[]) => {
		if (!overview) return;
		const fetch = ids.map(
			(id) => overview.fetch.find((view) => view.key === id)!,
		);
		void save({ fetchOrder: fetchIds(fetch) }, { ...overview, fetch });
	};

	const toggleFetch = (key: string, enabled: boolean) => {
		if (!overview) return;
		const fetch = overview.fetch.map(
			(view) => view.key === key ? { ...view, enabled } : view,
		);
		void save({ fetchOrder: fetchIds(fetch) }, { ...overview, fetch });
	};

	const saveReliability = (event: SubmitEvent) => {
		event.preventDefault();
		if (!draft) return;
		const retryBackoffMs = numberInput(backoff);
		const circuitFailureThreshold = numberInput(threshold);
		const circuitCooldownMs = numberInput(cooldown);
		if (
			[retryBackoffMs, circuitFailureThreshold, circuitCooldownMs].some(
				(value) => !Number.isInteger(value),
			)
		) {
			setReliabilityError(t('research.adapters.reliability.invalid'));
			return;
		}
		setReliabilityError('');
		void save({
			fallback: draft.fallback,
			fallbackOnEmpty: draft.fallbackOnEmpty,
			retryBackoffMs,
			circuitFailureThreshold,
			circuitCooldownMs,
		});
	};

	const editingView =
		editing === null || !overview
			? null
			: [...overview.search, ...overview.fetch].find(
				(view) => view.key === editing,
			) ?? null;

	const row = (
		item: AdapterItem,
		onToggle: (enabled: boolean) => void,
		lockOn: boolean,
	) => <div class="research-adapter">
		<span class="ui-cell">
			<b>{item.label}</b>
			<small class="ui-cell__muted">
				{item.view.lastErrorCode === null
					? t('research.adapters.description.' + item.view.key)
					: t('research.adapters.lastError', {
							error: errorCodeLabel(item.view.lastErrorCode),
						})}
			</small>
		</span>
		<Tag tone={adapterStatusTone(item.view.status)} dot>{adapterStatusLabel(
			item.view.status,
			item.view.openUntil,
		)}</Tag>
		<Switch
			checked={item.view.enabled}
			label={t('research.adapters.enable', { label: item.label })}
			disabled={lockOn && item.view.enabled}
			onChange={onToggle}
		/>
		<Button size="sm" onClick={() => setEditing(item.view.key)}>{t(
			'research.adapters.configure',
		)}</Button>
	</div>;

	<div class="research-adapters">
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('research.common.accessDenied')}>{t(
					'research.adapters.denied',
				)}</EmptyState>
			</section>
		} @else if (status === 'error') {
			<section class="ui-card">
				<div class="ui-card__body">
					<Alert>{error}</Alert>
					<div class="ui-form__actions">
						<Button size="sm" onClick={() => void load()}>{t(
							'research.common.retry',
						)}</Button>
					</div>
				</div>
			</section>
		} @else if (overview === null || draft === null) {
			<section class="ui-card">
				<div class="ui-card__body">
					<p class="ui-help" role="status">{t('research.common.loading')}</p>
				</div>
			</section>
		} @else {
			<>
				@if (saveError !== '') {
					<Alert>{saveError}</Alert>
				}
				<section class="ui-card">
					<header class="ui-card__head">
						<span class="ui-card__title">
							<b>{t('research.adapters.search.title')}</b>
							<small>{t('research.adapters.search.description')}</small>
						</span>
					</header>
					<div class="ui-card__body">
						@if (overview.legacy) {
							<Alert tone="info">{t('research.adapters.legacy', {
								label: adapterLabel(overview.search[0]?.key ?? ''),
							})}</Alert>
						}
						@if (!overview.search.some((view) => view.enabled)) {
							<EmptyState
								icon="search"
								title={t('research.adapters.emptyTitle')}
							>{t('research.adapters.emptyHint')}</EmptyState>
						}
						<SortableList
							id="research-search-adapters"
							label={t('research.adapters.search.title')}
							items={items(overview.search)}
							onReorder={reorderSearch}
							handleLabel={(item) => t('research.adapters.move', {
								label: item.label,
							})}
							instructions={t('research.adapters.instructions')}
							announce={announce}
							renderItem={(item) => row(
								item,
								(enabled) => toggleSearch(item.id, enabled),
								false,
							)}
						/>
					</div>
				</section>
				<section class="ui-card">
					<header class="ui-card__head">
						<span class="ui-card__title">
							<b>{t('research.adapters.reliability.title')}</b>
							<small>{t('research.adapters.reliability.description')}</small>
						</span>
					</header>
					<div class="ui-card__body">
						<form class="ui-form" onSubmit={saveReliability}>
							<div class="ui-form__row">
								<Select
									id="research-fallback"
									label={t('research.adapters.reliability.fallback')}
									options={[
										{
											value: 'next-adapter',
											label: t('research.adapters.fallback.next-adapter'),
										},
										{
											value: 'fail',
											label: t('research.adapters.fallback.fail'),
										},
									]}
									value={draft.fallback}
									disabled={saving}
									help={t('research.adapters.reliability.fallbackHelp')}
									onChange={(value) => setDraft({
										...draft,
										fallback: value === 'fail' ? 'fail' : 'next-adapter',
									})}
								/>
								<label class="ui-checkbox">
									<input
										type="checkbox"
										checked={draft.fallbackOnEmpty}
										disabled={saving}
										onChange={(event) => setDraft({
											...draft,
											fallbackOnEmpty: event.currentTarget.checked,
										})}
									/>
									{t('research.adapters.reliability.fallbackOnEmpty')}
								</label>
							</div>
							<div class="ui-form__row">
								<FormField
									label={t('research.adapters.reliability.backoff')}
									help={t('research.adapters.reliability.backoffHelp')}
								>
									<input
										class="ui-input"
										type="number"
										min="0"
										max="5000"
										value={backoff}
										disabled={saving}
										onInput={(event) => setBackoff(event.currentTarget.value)}
									/>
								</FormField>
								<FormField
									label={t('research.adapters.reliability.threshold')}
									help={t('research.adapters.reliability.thresholdHelp')}
								>
									<input
										class="ui-input"
										type="number"
										min="1"
										max="100"
										value={threshold}
										disabled={saving}
										onInput={(event) => setThreshold(event.currentTarget.value)}
									/>
								</FormField>
								<FormField
									label={t('research.adapters.reliability.cooldown')}
									help={t('research.adapters.reliability.cooldownHelp')}
								>
									<input
										class="ui-input"
										type="number"
										min="1000"
										max="86400000"
										value={cooldown}
										disabled={saving}
										onInput={(event) => setCooldown(event.currentTarget.value)}
									/>
								</FormField>
							</div>
							@if (reliabilityError !== '') {
								<Alert>{reliabilityError}</Alert>
							}
							<div class="ui-form__actions">
								<Button variant="primary" type="submit" disabled={saving}>
									{saving
										? t('research.common.saving')
										: t('research.adapters.reliability.save')}
								</Button>
							</div>
						</form>
						<div class="ui-form__section">
							<div class="ui-form__section-head">
								<b>{t('research.adapters.fetch.title')}</b>
								<small>{t('research.adapters.fetch.description')}</small>
							</div>
							<SortableList
								id="research-fetch-adapters"
								label={t('research.adapters.fetch.title')}
								items={items(overview.fetch)}
								onReorder={reorderFetch}
								handleLabel={(item) => t('research.adapters.move', {
									label: item.label,
								})}
								instructions={t('research.adapters.instructions')}
								announce={announce}
								renderItem={(item) => row(
									item,
									(enabled) => toggleFetch(item.id, enabled),
									overview.fetch.filter((view) => view.enabled).length === 1,
								)}
							/>
						</div>
					</div>
				</section>
				<AdapterDrawer
					open={editingView !== null}
					view={editingView}
					csrfToken={props.csrfToken}
					onClose={() => setEditing(null)}
					onSaved={accept}
				/>
			</>
		}
	</div>
}
