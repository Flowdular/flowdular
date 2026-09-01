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
import type { PartyKind } from '../domain/types.ts';
import { createParty, loadParties } from './api.ts';
import { createPartiesClientState } from './state.ts';
import { PartyForm } from './PartyForm.tsrx';

export interface PartiesViewProps {
	readonly csrfToken: string;
}

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

function kindLabel(kind: PartyKind): string {
	if (kind === 'both') return 'Customer + supplier';
	return kind[0]!.toUpperCase() + kind.slice(1);
}

export function PartiesView(props: PartiesViewProps) @{
	const partiesState = useMemo(() => createPartiesClientState(), []);
	const [parties] = useValue(partiesState.state.parties);
	const [status, setStatus] = useValue(partiesState.state.status);
	const [error, setError] = useValue(partiesState.state.error);
	const [query, setQuery] = useValue(partiesState.state.query);
	const [formOpen, setFormOpen] = useValue(partiesState.state.formOpen);
	const term = query.trim().toLocaleLowerCase('en-US');
	const visible =
		term === ''
			? parties
			: parties.filter(
					(party) =>
						party.name.toLocaleLowerCase('en-US').includes(term) ||
							(party.email ?? '').toLocaleLowerCase('en-US').includes(term),
				);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const records = await loadParties();
			partiesState.store.act(
				(transaction) => transaction.set(partiesState.state.parties, records),
				'parties/loaded',
			);
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: 'Could not load parties.',
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
			const party = await createParty(
				{
					name: formValue(form, 'name'),
					kind: formValue(form, 'kind') as PartyKind,
					email: formValue(form, 'email'),
					phone: formValue(form, 'phone'),
				},
				props.csrfToken,
			);
			partiesState.store.act(
				(transaction) => transaction.set(
					partiesState.state.parties,
					[...parties, party].sort(
						(left, right) => left.name.localeCompare(right.name),
					),
				),
				'parties/created',
			);
			element.reset();
			setFormOpen(false);
		} catch (createError) {
			setError(
				createError instanceof Error
					? createError.message
					: 'Could not create the party.',
			);
		} finally {
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow="Master data"
			title="Customers & suppliers"
			description="Shared business identities for sales, purchasing, and finance."
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				Refresh
			</Button>
			<Button size="sm" variant="primary" onClick={() => setFormOpen(true)}>
				<Icon name="plus" size={14} />
				New party
			</Button>
		</PageHeader>
		@if (error && !formOpen) {
			<Alert>{error}</Alert>
		}
		<section class="ui-card">
			<div class="ui-card__head">
				<span class="ui-card__title">
					Business parties
					<small>{parties.length + ' records'}</small>
				</span>
				<SearchField
					value={query}
					placeholder="Filter by name or email"
					label="Filter parties"
					onInput={setQuery}
				/>
			</div>
			@if (status === 'loading' && parties.length === 0) {
				<p class="ui-table__empty">Loading business parties…</p>
			} @else if (visible.length === 0) {
				<EmptyState
					icon="parties"
					title={term === '' ? 'No parties yet' : 'No matching parties'}
				>
					{term === ''
						? 'Create the first customer or supplier.'
						: 'No record in this workspace matches the current filter.'}
				</EmptyState>
			} @else {
				<div class="ui-table-wrap">
					<table class="ui-table" aria-label="Business parties">
						<thead>
							<tr>
								<th>Party</th>
								<th>Kind</th>
								<th>Status</th>
							</tr>
						</thead>
						<tbody>
							@for (const party of visible; key party.id) {
								<tr>
									<td>
										<span class="ui-cell">
											<b>{party.name}</b>
											<small>
												{party.email ?? party.phone ?? 'No contact details'}
											</small>
										</span>
									</td>
									<td>{kindLabel(party.kind)}</td>
									<td>
										<Tag
											tone={party.status === 'active' ? 'success' : 'neutral'}
											dot
										>{party.status}</Tag>
									</td>
								</tr>
							}
						</tbody>
					</table>
				</div>
			}
		</section>
		<Drawer
			open={formOpen}
			title="New party"
			subtitle="Customer, supplier, or both"
			onClose={() => setFormOpen(false)}
		>
			<PartyForm
				busy={status === 'submitting'}
				error={error}
				onCancel={() => setFormOpen(false)}
				onSubmit={(event) => void submit(event)}
			/>
		</Drawer>
	</div>
}

export function PartiesDashboardWidget() @{
	const widgetState = useMemo(() => createPartiesClientState(), []);
	const [parties] = useValue(widgetState.state.parties);
	const [status, setStatus] = useValue(widgetState.state.status);
	useEffect(() => {
		setStatus('loading');
		void loadParties().then((records) => {
			widgetState.store.act(
				(transaction) => transaction.set(widgetState.state.parties, records),
				'parties/widget-loaded',
			);
		}).catch(() => undefined).finally(() => setStatus('idle'));
	}, []);
	<Kpi
		label="Customers & suppliers"
		value={status === 'loading' ? '…' : String(parties.length)}
		note="Active business identities in this organization."
		href="/parties"
		linkLabel="Open parties"
	/>
}
