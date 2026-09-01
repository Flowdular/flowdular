import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	Drawer,
	EmptyState,
	Icon,
	Kpi,
	PageHeader,
	SearchField,
	Tag,
} from '@coreloom/ui';
import { useValue } from 'segment-state';
import type { CatalogItemKind } from '../domain/types.ts';
import { createCatalogItem, loadCatalogItems } from './api.ts';
import { createCatalogClientState } from './state.ts';
import { CatalogItemForm } from './CatalogItemForm.tsrx';

export interface CatalogViewProps {
	readonly csrfToken: string;
}

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

function price(minor: number, currency: string): string {
	try {
		return new Intl.NumberFormat('en', {
			style: 'currency',
			currency,
		}).format(minor / 100);
	} catch {
		return `${minor} ${currency} minor`;
	}
}

export function CatalogView(props: CatalogViewProps) @{
	const catalogState = useMemo(() => createCatalogClientState(), []);
	const [items] = useValue(catalogState.state.items);
	const [status, setStatus] = useValue(catalogState.state.status);
	const [error, setError] = useValue(catalogState.state.error);
	const [query, setQuery] = useValue(catalogState.state.query);
	const [formOpen, setFormOpen] = useValue(catalogState.state.formOpen);
	const [formSession, setFormSession] = useValue(
		catalogState.state.formSession,
	);
	const term = query.trim().toLocaleLowerCase('en-US');
	const visible =
		term === ''
			? items
			: items.filter(
					(item) =>
						item.name.toLocaleLowerCase('en-US').includes(term) ||
							item.sku.toLocaleLowerCase('en-US').includes(term),
				);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const records = await loadCatalogItems();
			catalogState.store.act(
				(transaction) => transaction.set(catalogState.state.items, records),
				'catalog/loaded',
			);
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: 'Could not load catalog items.',
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const element = event.currentTarget as HTMLFormElement;
		const form = new FormData(element);
		setStatus('submitting');
		setError('');
		try {
			const item = await createCatalogItem(
				{
					sku: formValue(form, 'sku'),
					name: formValue(form, 'name'),
					kind: formValue(form, 'kind') as CatalogItemKind,
					unit: formValue(form, 'unit'),
					basePriceMinor: Number(formValue(form, 'basePriceMinor')),
					currency: formValue(form, 'currency'),
				},
				props.csrfToken,
			);
			catalogState.store.act(
				(transaction) => transaction.set(
					catalogState.state.items,
					[...items, item].sort(
						(left, right) => left.sku.localeCompare(right.sku),
					),
				),
				'catalog/created',
			);
			element.reset();
			setFormSession((current) => current + 1);
			setFormOpen(false);
		} catch (createError) {
			setError(
				createError instanceof Error
					? createError.message
					: 'Could not create the catalog item.',
			);
		} finally {
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow="Commercial master data"
			title="Catalog"
			description="Products and services with stable tenant-scoped SKUs."
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				Refresh
			</Button>
			<Button size="sm" variant="primary" onClick={() => setFormOpen(true)}>
				<Icon name="plus" size={14} />
				New item
			</Button>
		</PageHeader>
		@if (error && !formOpen) {
			<Alert>{error}</Alert>
		}
		<section class="ui-card">
			<div class="ui-card__head">
				<span class="ui-card__title">
					Products & services
					<small>{items.length + ' items'}</small>
				</span>
				<SearchField
					value={query}
					placeholder="Filter by name or SKU"
					label="Filter catalog items"
					onInput={setQuery}
				/>
			</div>
			@if (status === 'loading' && items.length === 0) {
				<p class="ui-table__empty">Loading catalog items…</p>
			} @else if (visible.length === 0) {
				<EmptyState
					icon="catalog"
					title={term === '' ? 'No catalog items yet' : 'No matching items'}
				>
					{term === ''
						? 'Create the first product or service.'
						: 'No item in this workspace matches the current filter.'}
				</EmptyState>
			} @else {
				<div class="ui-table-wrap">
					<table class="ui-table" aria-label="Catalog items">
						<thead>
							<tr>
								<th>Item</th>
								<th>Kind</th>
								<th class="num">Price</th>
							</tr>
						</thead>
						<tbody>
							@for (const item of visible; key item.id) {
								<tr>
									<td>
										<span class="ui-cell">
											<b>{item.name}</b>
											<small class="ui-mono">
												{item.sku + ' · ' + item.unit}
											</small>
										</span>
									</td>
									<td>
										<Tag
											tone={item.kind === 'product' ? 'info' : 'neutral'}
										>{item.kind}</Tag>
									</td>
									<td class="num">{price(
										item.basePriceMinor,
										item.currency,
									)}</td>
								</tr>
							}
						</tbody>
					</table>
				</div>
			}
		</section>
		<Drawer
			open={formOpen}
			title="New catalog item"
			subtitle="Product or service"
			onClose={() => setFormOpen(false)}
		>
			<CatalogItemForm
				key={'catalog-form-' + formSession}
				busy={status === 'submitting'}
				error={error}
				onCancel={() => setFormOpen(false)}
				onSubmit={(event) => void submit(event)}
			/>
		</Drawer>
	</div>
}

export function CatalogDashboardWidget() @{
	const widgetState = useMemo(() => createCatalogClientState(), []);
	const [items] = useValue(widgetState.state.items);
	const [status, setStatus] = useValue(widgetState.state.status);
	useEffect(() => {
		setStatus('loading');
		void loadCatalogItems().then((records) => {
			widgetState.store.act(
				(transaction) => transaction.set(widgetState.state.items, records),
				'catalog/widget-loaded',
			);
		}).catch(() => undefined).finally(() => setStatus('idle'));
	}, []);
	<Kpi
		label="Catalog items"
		value={status === 'loading' ? '…' : String(items.length)}
		note="Active catalog entries with tenant-scoped SKUs."
		href="/catalog"
		linkLabel="Open catalog"
	/>
}
