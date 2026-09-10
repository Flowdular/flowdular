import { useEffect, useMemo } from 'octane';
import { Alert, Chart, EmptyState } from '@flowdular/ui';
import { cell, createStore, useValue } from 'segment-state';
import { activeLocale, t } from '../i18n/runtime.ts';

/* The shell reads the overview over HTTP: system.core owns the endpoint and its
   typed client, but the shell is a lower layer and cannot import a module, so
   the wire shape is mirrored here at the boundary. */
interface ActivityPoint {
	readonly date: string;
	readonly count: number;
}

interface ModulePoint {
	readonly id: string;
	readonly name: string;
	readonly permissions: number;
}

interface Overview {
	readonly enabledModuleCount: number;
	readonly moduleCount: number;
	readonly activity: readonly ActivityPoint[];
	readonly modules: readonly ModulePoint[];
}

type OverviewStatus = 'loading' | 'ready' | 'error';

async function loadOverview(): Promise<Overview> {
	const response = await fetch('/api/system/overview', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	const value = await response.json() as
		Overview & {
			readonly error?: { readonly message?: string };
		};
	if (!response.ok) {
		throw new Error(value.error?.message ?? t('shell.overview.error'));
	}
	return value;
}

function formatDay(value: string): string {
	const date = new Date(value + 'T00:00:00Z');
	return new Intl.DateTimeFormat(activeLocale(), {
		month: 'numeric',
		day: 'numeric',
		timeZone: 'UTC',
	}).format(date);
}

export function OverviewCharts() @{
	const store = useMemo(
		() => createStore({
			overview: cell<Overview | null>(null),
			status: cell<OverviewStatus>('loading'),
			error: '',
		}),
		[],
	);
	const [overview] = useValue(store.state.overview);
	const [status] = useValue(store.state.status);
	const [error] = useValue(store.state.error);

	useEffect(() => {
		let active = true;
		void (async () => {
			try {
				const data = await loadOverview();
				if (!active) return;
				store.act((transaction) => {
					transaction.set(store.state.overview, data);
					transaction.set(store.state.status, 'ready');
				}, 'shell/overview-loaded');
			} catch (loadError) {
				if (!active) return;
				store.act((transaction) => {
					transaction.set(
						store.state.error,
						loadError instanceof Error
							? loadError.message
							: t('shell.overview.error'),
					);
					transaction.set(store.state.status, 'error');
				}, 'shell/overview-error');
			}
		})();
		return () => {
			active = false;
		};
	}, []);

	const activitySeries = [
		{ key: 'count', label: t('shell.overview.activity.series') },
	];
	const modulesSeries = [
		{ key: 'permissions', label: t('shell.overview.modules.series') },
	];
	const activity = overview?.activity ?? [];
	const activeDays = activity.filter((point) => point.count > 0).length;
	const modules = overview?.modules ?? [];

	<>
		@if (status === 'error') {
			<Alert>{error}</Alert>
		} @else {
			<div class="ui-grid-2">
				<section class="ui-card">
					<div class="ui-card__head">
						<span class="ui-card__title">
							{t('shell.overview.activity.title')}
							<small>{t('shell.overview.activity.subtitle')}</small>
						</span>
					</div>
					<div class="ui-card__body">
						@if (status === 'loading') {
							<p class="dash-chart__note">{t(
								'shell.overview.activity.loading',
							)}</p>
						} @else if (activeDays <= 1) {
							<EmptyState
								icon="activity"
								title={t('shell.overview.activity.empty.title')}
							>{t('shell.overview.activity.empty.hint')}</EmptyState>
						} @else {
							<Chart
								type="area"
								xKey="date"
								height={220}
								title={t('shell.overview.activity.subtitle')}
								data={activity}
								series={activitySeries}
								xTickFormatter={formatDay}
							/>
						}
					</div>
				</section>
				<section class="ui-card">
					<div class="ui-card__head">
						<span class="ui-card__title">
							{t('shell.overview.modules.title')}
							<small>{t('shell.overview.modules.subtitle')}</small>
						</span>
					</div>
					<div class="ui-card__body">
						@if (status === 'loading') {
							<p class="dash-chart__note">{t(
								'shell.overview.modules.loading',
							)}</p>
						} @else {
							<Chart
								type="bar"
								xKey="name"
								height={220}
								title={t('shell.overview.modules.subtitle')}
								data={modules}
								series={modulesSeries}
								emptyTitle={t('shell.overview.modules.empty.title')}
							/>
						}
					</div>
				</section>
			</div>
		}
	</>
}
