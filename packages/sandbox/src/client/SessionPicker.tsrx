import { useState } from 'octane';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	Filters,
	FormField,
	Icon,
	Kpi,
	PageHeader,
	SearchField,
	TableCard,
	Tag,
	type TableColumn,
} from '@flowdular/ui';
import type { SandboxSession } from '../server/sessions.ts';
import type {
	DashboardRow,
	SandboxDashboard,
	WorkStatus,
} from '../server/dashboard.ts';
import type { DriverSummary, RoleSummary } from './api.ts';
import { NewSessionForm } from './NewSessionForm.tsrx';
import { filterWork, formatCost, formatTokens } from './dashboard.ts';
import { activeLocale, t, useTranslation } from './i18n.ts';

export interface SessionPickerProps {
	readonly onDeliverySettings: () => void;
	readonly sessions: readonly SandboxSession[];
	readonly dashboard?: SandboxDashboard | undefined;
	readonly onRefresh: () => void;
	readonly onReject: (id: string) => void;
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

const statuses: readonly WorkStatus[] = [
	'draft',
	'working',
	'approval',
	'approved',
	'changes',
	'rejected',
	'attention',
	'review',
	'delivered',
	'archived',
];

function tone(
	status: WorkStatus,
): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
	if (status === 'rejected' || status === 'attention') return 'danger';
	if (status === 'approved' || status === 'delivered') return 'success';
	if (status === 'approval' || status === 'changes') return 'warning';
	return status === 'working' || status === 'review' ? 'info' : 'neutral';
}

function columns(): readonly TableColumn<DashboardRow>[] {
	return [
		{
			key: 'work',
			header: t('sandbox.dashboard.work'),
			width: '32%',
			cell: (row) => <span class="ui-cell">
				<b>{row.session.title}</b>
				<small>
					{t(
						row.session.kind === 'new-module'
							? 'sandbox.sessions.kind.new'
							: 'sandbox.sessions.kind.change',
					)}
					·
					{t('sandbox.dashboard.modules', {
						count: row.session.modules.length,
					})}
				</small>
				{row.personal
					? null
					: <small>{t('sandbox.dashboard.legacyRow')}</small>}
			</span>,
		},
		{
			key: 'status',
			header: t('sandbox.dashboard.status'),
			width: '20%',
			cell: (row) =>
				<Tag tone={tone(row.status)} dot>{t(
					'sandbox.dashboard.status.' + row.status,
				)}</Tag>,
		},
		{
			key: 'tokens',
			header: t('sandbox.dashboard.table.tokens'),
			width: '13%',
			numeric: true,
			cell: (row) => formatTokens(row.usage, activeLocale()),
		},
		{
			key: 'cost',
			header: t('sandbox.dashboard.table.cost'),
			width: '13%',
			numeric: true,
			cell: (row) => formatCost(row.usage, activeLocale()),
		},
		{
			key: 'updated',
			header: t('sandbox.dashboard.table.updated'),
			width: '12%',
			cell: (row) => new Intl.DateTimeFormat(activeLocale(), {
				day: 'numeric',
				month: 'short',
			}).format(row.session.updatedAt),
		},
	];
}

export function SessionPicker(props: SessionPickerProps) @{
	const { t } = useTranslation();
	const [creating, setCreating] = useState(false);
	const [query, setQuery] = useState('');
	const [status, setStatus] = useState('');
	const [filtersOpen, setFiltersOpen] = useState(false);
	const [detailId, setDetailId] = useState('');
	const [confirmation, setConfirmation] = useState<'reject' | 'delete' | ''>(
		'',
	);
	const dashboard = props.dashboard;
	const rows = filterWork(
		dashboard?.rows ?? [],
		query,
		status,
		props.showArchived,
		activeLocale(),
	);
	const detail =
		dashboard?.rows.find((row) => row.session.id === detailId) ?? null;
	const counts = dashboard?.counts;
	const usage = dashboard?.usage;
	const locked =
		props.busy || detail !== null && props.running.includes(detail.session.id);
	const number = (value: number) =>
		new Intl.NumberFormat(activeLocale()).format(value);
	const closeDetail = () => {
		setDetailId('');
		setConfirmation('');
	};

	<div class="sessions">
		<PageHeader
			eyebrow={t('sandbox.dashboard.eyebrow')}
			title={t('sandbox.dashboard.title')}
			description={t('sandbox.dashboard.description')}
		>
			<div class="sessions__actions">
				<Button size="sm" disabled={props.busy} onClick={props.onRefresh}>
					<Icon name="refresh" size={14} />
					{t('sandbox.dashboard.refresh')}
				</Button>
				<Button size="sm" onClick={props.onDeliverySettings}>
					<Icon name="settings" size={14} />
					{t('sandbox.github.dashboardAction')}
				</Button>
				<Button
					size="sm"
					variant="primary"
					disabled={props.busy}
					onClick={() => setCreating(true)}
				>
					<Icon name="plus" size={14} />
					{t('sandbox.dashboard.new')}
				</Button>
			</div>
		</PageHeader>
		<div class="ui-kpi-grid">
			<Kpi
				label={t('sandbox.dashboard.inProgress')}
				value={counts
					? number(
							counts.draft + counts.working + counts.changes + counts.attention,
						)
					: '…'}
				note={t('sandbox.dashboard.inProgressNote')}
			/>
			<Kpi
				label={t('sandbox.dashboard.status.approval')}
				value={counts ? number(counts.approval) : '…'}
				note={t('sandbox.dashboard.approvalNote')}
			/>
			<Kpi
				label={t('sandbox.dashboard.status.approved')}
				value={counts
					? number(counts.approved + counts.review + counts.delivered)
					: '…'}
				note={t('sandbox.dashboard.acceptedNote', {
					delivered: counts?.delivered ?? 0,
					review: counts?.review ?? 0,
				})}
			/>
			<Kpi
				label={t('sandbox.dashboard.status.rejected')}
				value={counts ? number(counts.rejected) : '…'}
				note={t('sandbox.dashboard.rejectedNote')}
			/>
		</div>
		<div class="ui-grid-2">
			<Kpi
				label={t('sandbox.dashboard.tokens')}
				value={usage ? formatTokens(usage, activeLocale()) : '…'}
				note={t('sandbox.dashboard.tokensNote', {
					input: number(usage?.inputTokens ?? 0),
					output: number(usage?.outputTokens ?? 0),
				})}
			/>
			<Kpi
				label={t('sandbox.dashboard.cost')}
				value={usage ? formatCost(usage, activeLocale()) : '…'}
				note={t('sandbox.dashboard.costNote')}
			/>
		</div>
		@if (usage && (usage.unpricedTurns > 0 || usage.missingUsage > 0)) {
			<Alert tone="info">{t('sandbox.dashboard.incomplete', {
				cost: usage.unpricedTurns,
				tokens: usage.missingUsage,
			})}</Alert>
		}
		@if (dashboard && dashboard.legacySessions > 0) {
			<Alert tone="info">{t('sandbox.dashboard.legacyNote', {
				count: dashboard.legacySessions,
			})}</Alert>
		}
		<TableCard
			title={t('sandbox.dashboard.sessions')}
			count={number(rows.length)}
			columns={columns()}
			rows={rows}
			rowKey={(row) => row.session.id}
			status={dashboard ? 'idle' : 'loading'}
			loadingLabel={t('sandbox.dashboard.loading')}
			search={<SearchField
				value={query}
				onInput={setQuery}
				label={t('sandbox.dashboard.search')}
				placeholder={t('sandbox.dashboard.search')}
			/>}
			filters={<Filters
				open={filtersOpen}
				onToggle={() => setFiltersOpen(!filtersOpen)}
				activeCount={(status ? 1 : 0) + (props.showArchived ? 1 : 0)}
				label={t('sandbox.dashboard.filters')}
			>
				<FormField label={t('sandbox.dashboard.status')}>
					<select
						class="ui-select"
						value={status}
						onChange={(event) => setStatus(event.currentTarget.value)}
					>
						<option value="">{t('sandbox.dashboard.all')}</option>
						@for (const item of statuses; key item) {
							<option value={item}>{t(
								'sandbox.dashboard.status.' + item,
							)}</option>
						}
					</select>
				</FormField>
				<label class="ui-checkbox">
					<input
						type="checkbox"
						checked={props.showArchived}
						onChange={(event) => props.onShowArchived(
							event.currentTarget.checked,
						)}
					/>
					<span>{t('sandbox.sessions.archived.show')}</span>
				</label>
			</Filters>}
			filtered={Boolean(query.trim() || status || props.showArchived)}
			empty={{
				icon: 'flask',
				title: t('sandbox.dashboard.empty'),
				hint: t('sandbox.dashboard.emptyHint'),
			}}
			emptyFiltered={{
				icon: 'search',
				title: t('sandbox.dashboard.noMatch'),
				hint: t('sandbox.dashboard.noMatchHint'),
			}}
			actionsWidth="240px"
			actionsLabel={t('sandbox.sessions.actions')}
			actions={(row) => [
				{
					id: 'open',
					label: t('sandbox.dashboard.open'),
					icon: 'external',
					onSelect: () => props.onOpen(row.session.id),
				},
				{
					id: 'details',
					label: t('sandbox.dashboard.details'),
					icon: 'activity',
					onSelect: () => setDetailId(row.session.id),
				},
			]}
			note={t('sandbox.dashboard.scopeNote', {
				count: dashboard?.deletedSessions ?? 0,
			})}
		/>
		<Drawer
			open={creating}
			title={t('sandbox.dashboard.new')}
			subtitle={t('sandbox.dashboard.newHint')}
			width="lg"
			onClose={() => {
				if (!props.busy) setCreating(false);
			}}
		>
			<NewSessionForm
				drivers={props.drivers}
				driver={props.driver}
				busy={props.busy}
				onDriver={props.onDriver}
				onCreate={props.onCreate}
			/>
		</Drawer>
		<Drawer
			open={detail !== null}
			title={detail?.session.title ?? ''}
			subtitle={t('sandbox.dashboard.detailHint')}
			width="lg"
			onClose={closeDetail}
		>
			<div class="ui-drawer__body">
				@if (detail) {
					<div class="ui-form">
						<div class="ui-tag-cloud">
							<Tag tone={tone(detail.status)} dot>{t(
								'sandbox.dashboard.status.' + detail.status,
							)}</Tag>
						</div>
						<p class="ui-help">{detail.session.brief}</p>
						<div class="ui-grid-2">
							<Kpi
								label={t('sandbox.dashboard.tokens')}
								value={formatTokens(detail.usage, activeLocale())}
								note={t('sandbox.dashboard.tokensHelp')}
							/>
							<Kpi
								label={t('sandbox.dashboard.cost')}
								value={formatCost(detail.usage, activeLocale())}
								note={t('sandbox.dashboard.costNote')}
							/>
						</div>
						<p class="ui-help">{t('sandbox.dashboard.moduleApprovals', {
							approved: detail.approvedModules,
							total: detail.session.modules.length,
						})}</p>
						<TableCard
							title={t('sandbox.dashboard.phases')}
							rows={detail.phases}
							rowKey={(phase) => phase.role}
							columns={[
								{
									key: 'phase',
									header: t('sandbox.dashboard.phase'),
									width: '50%',
									cell: (phase) => t('sandbox.dashboard.role.' + phase.role) ===
									'sandbox.dashboard.role.' + phase.role
										? t('sandbox.dashboard.role.unknown')
										: t('sandbox.dashboard.role.' + phase.role),
								},
								{
									key: 'tokens',
									header: t('sandbox.dashboard.table.tokens'),
									width: '25%',
									numeric: true,
									cell: (phase) => formatTokens(phase.usage, activeLocale()),
								},
								{
									key: 'cost',
									header: t('sandbox.dashboard.table.cost'),
									width: '25%',
									numeric: true,
									cell: (phase) => formatCost(phase.usage, activeLocale()),
								},
							]}
							empty={{
								icon: 'activity',
								title: t('sandbox.dashboard.noUsage'),
								hint: t('sandbox.dashboard.noUsageHint'),
							}}
						/>
						<div class="ui-form__actions">
							@if (detail.session.archivedAt) {
								<Button
									disabled={locked}
									onClick={() => props.onRestore(detail.session.id)}
								>{t('sandbox.common.restore')}</Button>
							} @else {
								<Button
									disabled={locked}
									onClick={() => props.onArchive(detail.session.id)}
								>{t('sandbox.sessions.archive')}</Button>
							}
							@if (!detail.session.ejectedAt && !detail.session.rejectedAt) {
								<Button
									disabled={locked}
									onClick={() => setConfirmation('reject')}
								>{t('sandbox.dashboard.reject')}</Button>
							}
						</div>
						<div class="ui-form__section ui-form__section--danger">
							<div class="ui-form__section-head">
								<b>{t('sandbox.common.delete')}</b>
								<small>{t('sandbox.dashboard.deleteHint')}</small>
							</div>
							<Button
								variant="danger"
								disabled={locked}
								onClick={() => setConfirmation('delete')}
							>{t('sandbox.common.delete')}</Button>
						</div>
					</div>
				}
			</div>
		</Drawer>
		<ConfirmDialog
			open={confirmation !== '' && detail !== null}
			title={t(
				confirmation === 'reject'
					? 'sandbox.dashboard.rejectTitle'
					: 'sandbox.common.delete',
			)}
			confirmLabel={t(
				confirmation === 'reject'
					? 'sandbox.dashboard.reject'
					: 'sandbox.common.delete',
			)}
			cancelLabel={t('sandbox.common.cancel')}
			busy={props.busy}
			onCancel={() => setConfirmation('')}
			onConfirm={() => {
				if (!detail) return;
				if (confirmation === 'reject') props.onReject(detail.session.id);
				else props.onDelete(detail.session.id);
				closeDetail();
			}}
		>{t(
			confirmation === 'reject'
				? 'sandbox.dashboard.rejectHint'
				: 'sandbox.dashboard.deleteHint',
		)}</ConfirmDialog>
	</div>
}
