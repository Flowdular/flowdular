import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	Drawer,
	Filters,
	Icon,
	PageHeader,
	SearchField,
	TableCard,
	Tag,
	type TableColumn,
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import { useValue } from 'segment-state';
import type { AutomationTrigger } from '../domain/types.ts';
import {
	createAutomationTrigger,
	deleteAutomationTrigger,
	loadAutomationTriggers,
	rotateAutomationTrigger,
	updateAutomationTrigger,
} from './api.ts';
import type { AutomationTriggerFormValue } from './AutomationTriggerForm.tsrx';
import { AutomationTriggerForm } from './AutomationTriggerForm.tsrx';
import { createAutomationTriggerClientState } from './state.ts';
import { timestampLabel } from './presentation.ts';

export interface AutomationTriggersViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

function triggerColumns(): readonly TableColumn<AutomationTrigger>[] {
	return [
		{
			key: 'trigger',
			header: t('automations.triggers.column.trigger'),
			width: '30%',
			cell: (trigger) => <span class="ui-cell">
				<b>{trigger.label}</b>
				<small class="ui-mono">{t('automations.triggers.secretRevision', {
					revision: trigger.secretRevision,
				})}</small>
			</span>,
		},
		{
			key: 'target',
			header: t('automations.common.target'),
			width: '20%',
			cell: (trigger) => <span class="ui-cell">
				<span>{trigger.targetName}</span>
				<small class="ui-cell__muted">
					{trigger.targetAvailable
						? t('automations.targetKind.' + trigger.targetKind)
						: t('automations.common.targetUnavailable', {
								kind: t('automations.targetKind.' + trigger.targetKind),
							})}
				</small>
			</span>,
		},
		{
			key: 'last-fired',
			header: t('automations.triggers.column.lastFired'),
			width: '18%',
			cell: (trigger) => timestampLabel(trigger.lastFiredAt),
		},
		{
			key: 'accepted',
			header: t('automations.triggers.column.accepted'),
			width: '10%',
			numeric: true,
			cell: (trigger) => trigger.acceptedCount,
		},
		{
			key: 'rejected',
			header: t('automations.triggers.column.rejected'),
			width: '10%',
			numeric: true,
			cell: (trigger) => trigger.rejectedCount,
		},
		{
			key: 'state',
			header: t('automations.common.state'),
			width: '12%',
			cell: (trigger) =>
				<Tag tone={trigger.enabled ? 'success' : 'neutral'} dot>{t(
					trigger.enabled
						? 'automations.common.enabled'
						: 'automations.common.disabled',
				)}</Tag>,
		},
	];
}

export function AutomationTriggersView(props: AutomationTriggersViewProps) @{
	const client = useMemo(() => createAutomationTriggerClientState(), []);
	const [triggers] = useValue(client.state.triggers);
	const [targets] = useValue(client.state.targets);
	const [selectedId, setSelectedId] = useValue(client.state.selectedTriggerId);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [enabledOnly, setEnabledOnly] = useValue(client.state.enabledOnly);
	const [filtersOpen, setFiltersOpen] = useValue(client.state.filtersOpen);
	const [editorOpen, setEditorOpen] = useValue(client.state.editorOpen);
	const [secret, setSecret] = useValue(client.state.revealedSecret);
	const selected =
		triggers.find((trigger) => trigger.id === selectedId) ?? null;
	const term = query.trim().toLocaleLowerCase(activeLocale());
	const visible = triggers.filter(
		(trigger) =>
			(!enabledOnly || trigger.enabled) &&
				(term === '' ||
					trigger.label.toLocaleLowerCase(activeLocale()).includes(term) ||
					trigger.targetName.toLocaleLowerCase(activeLocale()).includes(term)),
	);
	const filtered = term !== '' || enabledOnly;

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const result = await loadAutomationTriggers();
			client.store.act((transaction) => {
				transaction.set(client.state.triggers, result.triggers);
				transaction.set(client.state.targets, result.targets);
			}, 'automation-triggers/loaded');
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: t('automations.triggers.error.load'),
			);
		} finally {
			setStatus('idle');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const open = (triggerId: string) => {
		setSecret('');
		setSelectedId(triggerId);
		setEditorOpen(true);
	};

	const close = () => {
		setSecret('');
		setEditorOpen(false);
	};

	const save = async (value: AutomationTriggerFormValue) => {
		setStatus('submitting');
		setError('');
		try {
			if (selected) {
				await updateAutomationTrigger(selected.id, value, props.csrfToken);
				setEditorOpen(false);
			} else {
				const created = await createAutomationTrigger(value, props.csrfToken);
				client.store.act((transaction) => {
					transaction.set(client.state.selectedTriggerId, created.trigger.id);
					transaction.set(client.state.revealedSecret, created.secret);
				}, 'automation-triggers/created');
			}
			await refresh();
		} catch (saveError) {
			setError(
				saveError instanceof Error
					? saveError.message
					: t('automations.triggers.error.save'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const rotate = async () => {
		if (!selected) return;
		setStatus('submitting');
		setError('');
		try {
			const rotated = await rotateAutomationTrigger(
				selected.id,
				props.csrfToken,
			);
			setSecret(rotated.secret);
			await refresh();
		} catch (rotateError) {
			setError(
				rotateError instanceof Error
					? rotateError.message
					: t('automations.triggers.error.rotate'),
			);
		} finally {
			setStatus('idle');
		}
	};

	const remove = async () => {
		if (!selected) return;
		setStatus('submitting');
		setError('');
		try {
			await deleteAutomationTrigger(selected.id, props.csrfToken);
			setSelectedId('');
			close();
			await refresh();
		} catch (deleteError) {
			setError(
				deleteError instanceof Error
					? deleteError.message
					: t('automations.triggers.error.delete'),
			);
		} finally {
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('automations.common.eyebrow')}
			title={t('automations.triggers.title')}
			description={t('automations.triggers.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{status === 'loading'
					? t('automations.common.refreshing')
					: t('automations.common.refresh')}
			</Button>
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={() => open('')}>
					<Icon name="plus" size={14} />
					{t('automations.triggers.new')}
				</Button>
			}
		</PageHeader>
		@if (error) {
			<Alert>{error}</Alert>
		}
		<TableCard
			title={t('automations.triggers.table.title')}
			count={t('automations.triggers.table.count', {
				enabled: triggers.filter((trigger) => trigger.enabled).length,
				total: triggers.length,
			})}
			search={<SearchField
				value={query}
				placeholder={t('automations.triggers.search.placeholder')}
				label={t('automations.triggers.search.label')}
				onInput={setQuery}
			/>}
			filters={<Filters
				open={filtersOpen}
				onToggle={() => setFiltersOpen(!filtersOpen)}
				activeCount={enabledOnly ? 1 : 0}
				label={t('automations.common.filters')}
			>
				<label class="ui-checkbox">
					<input
						type="checkbox"
						checked={enabledOnly}
						onChange={(event: Event) => setEnabledOnly(
							(event.currentTarget as HTMLInputElement).checked,
						)}
					/>
					<span>{t('automations.common.enabledOnly')}</span>
				</label>
			</Filters>}
			columns={triggerColumns()}
			rows={visible}
			rowKey={(trigger) => trigger.id}
			status={status === 'loading' && triggers.length === 0
				? 'loading'
				: 'idle'}
			loadingLabel={t('automations.triggers.loading')}
			empty={{
				icon: 'plug',
				title: t('automations.triggers.empty.title'),
				hint: t('automations.triggers.empty.hint'),
			}}
			filtered={filtered}
			emptyFiltered={{
				icon: 'search',
				title: t('automations.triggers.empty.filteredTitle'),
				hint: t('automations.triggers.empty.filteredHint'),
			}}
			actionsLabel={t('automations.common.actions')}
			actions={props.canManage
				? (trigger) => [
						{
							id: 'open',
							label: t('automations.common.edit'),
							icon: 'file-text',
							onSelect: () => open(trigger.id),
						},
					]
				: undefined}
			note={t('automations.triggers.note')}
			noteIcon="shield"
			caption={t('automations.triggers.table.caption')}
		/>
		<Drawer
			open={editorOpen}
			title={selected ? selected.label : t('automations.triggers.new')}
			subtitle={selected
				? selected.targetName
				: t('automations.triggers.drawer.subtitle')}
			width="lg"
			onClose={close}
		>
			<AutomationTriggerForm
				key={selected?.id ?? 'new-trigger'}
				trigger={selected}
				targets={targets}
				busy={status === 'submitting'}
				secret={secret}
				onCancel={close}
				onRotate={selected && props.canManage ? () => rotate() : undefined}
				onDelete={selected && props.canManage ? () => remove() : undefined}
				onSubmit={save}
			/>
		</Drawer>
	</div>
}
