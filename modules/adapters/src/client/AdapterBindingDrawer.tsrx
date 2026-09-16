import { useEffect, useState } from 'octane';
import {
	Alert,
	Button,
	CellNumber,
	CellStack,
	CellTag,
	CellText,
	Drawer,
	EmptyState,
	FormField,
	Icon,
	Select,
	Switch,
	Table,
	type TableColumn,
} from '@flowdular/ui';
import { t } from '@flowdular/client/i18n';
import {
	ADAPTER_TRANSFORMS,
	type AdapterTransform,
} from '../domain/registry.ts';
import type { DryRunRow, DryRunResult } from '../services/adapters-service.ts';
import {
	adaptersErrorMessage,
	dryRun,
	loadInstances,
	saveBinding,
	type AdapterListItem,
	type ConnectorInstanceOption,
} from './api.ts';
import { draftOf, rulesOf, type MappingDraft } from './mapping-form.ts';
import { codeLabel, outcomeLabel, outcomeTone } from './presentation.ts';

export interface AdapterBindingDrawerProps {
	readonly open: boolean;
	readonly adapter: AdapterListItem | null;
	readonly csrfToken: string;
	readonly onClose: () => void;
	readonly onSaved: () => void;
}

type ScheduleMode = 'declared' | 'none' | 'custom';

function previewColumns(): readonly TableColumn<DryRunRow>[] {
	return [
		{
			key: 'index',
			header: t('adapters.rows.column.index'),
			width: '96px',
			numeric: true,
			cell: (row) => <CellNumber value={row.index} />,
		},
		{
			key: 'values',
			header: t('adapters.dryRun.column.values'),
			width: 'auto',
			cell: (row) =>
				<CellText
					value={Object.entries(row.values).map(
						([field, value]) => `${field}: ${value}`,
					).join(' · ')}
					mono
					wrap
				/>,
		},
		{
			key: 'outcome',
			header: t('adapters.rows.column.outcome'),
			width: '240px',
			cell: (row) =>
				<CellStack
					primary={<CellTag
						tone={outcomeTone(row.outcome)}
						dot
						label={outcomeLabel(row.outcome)}
					/>}
					secondary={(codeLabel(row.code) +
						(row.field ? ` (${row.field})` : '')).trim()}
				/>,
		},
	];
}

export function AdapterBindingDrawer(props: AdapterBindingDrawerProps) @{
	const adapter = props.adapter;
	const [instances, setInstances] = useState<
		readonly ConnectorInstanceOption[]
	>([]);
	const [instanceId, setInstanceId] = useState('');
	const [enabled, setEnabled] = useState(false);
	const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('declared');
	const [cron, setCron] = useState('');
	const [drafts, setDrafts] = useState<readonly MappingDraft[]>([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const [preview, setPreview] = useState<DryRunResult | null>(null);
	const [previewing, setPreviewing] = useState(false);
	const [previewError, setPreviewError] = useState('');

	useEffect(() => {
		if (!props.open || !adapter) return;
		const binding = adapter.binding;
		setInstanceId(binding?.instanceId ?? '');
		setEnabled(binding?.enabled ?? false);
		setScheduleMode(
			binding?.schedule === undefined || binding.schedule === null
				? 'declared'
				: binding.schedule === ''
					? 'none'
					: 'custom',
		);
		setCron(binding?.schedule ?? '');
		setDrafts((binding?.mapping ?? adapter.mapping).map(draftOf));
		setError('');
		setPreview(null);
		setPreviewError('');
		setInstances([]);
		void loadInstances(adapter.connector).then(setInstances).catch(
			(failure: unknown) => setError(
				adaptersErrorMessage(failure, 'adapters.error.instances'),
			),
		);
	}, [props.open, adapter?.id]);

	const update = (key: string, change: Partial<MappingDraft>) => setDrafts(
		drafts.map(
			(entry) => (entry.key === key ? { ...entry, ...change } : entry),
		),
	);

	const mapping = () => {
		const rules = rulesOf(drafts);
		/* The declared mapping stays declared, so a later release that changes
   it reaches a workspace that never edited it. */
		return adapter && JSON.stringify(rules) === JSON.stringify(adapter.mapping)
			? null
			: rules;
	};

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		if (!adapter) return;
		setSaving(true);
		setError('');
		try {
			await saveBinding(
				{
					adapterId: adapter.id,
					instanceId: instanceId === '' ? null : instanceId,
					enabled,
					mapping: mapping(),
					schedule: scheduleMode === 'declared'
						? null
						: scheduleMode === 'none'
							? ''
							: cron.trim(),
				},
				props.csrfToken,
			);
			props.onSaved();
		} catch (failure) {
			setError(adaptersErrorMessage(failure, 'adapters.error.save'));
		} finally {
			setSaving(false);
		}
	};

	const runPreview = async () => {
		if (!adapter) return;
		setPreviewing(true);
		setPreviewError('');
		setPreview(null);
		try {
			setPreview(await dryRun(adapter.id, rulesOf(drafts), props.csrfToken));
		} catch (failure) {
			setPreviewError(adaptersErrorMessage(failure, 'adapters.error.dryRun'));
		} finally {
			setPreviewing(false);
		}
	};

	const selected = instances.find((instance) => instance.id === instanceId);
	const fields =
		adapter?.target.kind === 'port' ? adapter.target.fields : [];
	const columns =
		adapter?.target.kind === 'list' ? adapter.target.columns : [];

	<Drawer
		open={props.open && adapter !== null}
		title={adapter ? adapter.label : ''}
		subtitle={adapter ? adapter.id : ''}
		width="lg"
		onClose={props.onClose}
	>
		<form class="ui-drawer__form" onSubmit={submit}>
			<div class="ui-drawer__body">
				@if (adapter && !adapter.target.available) {
					<Alert tone="warning">{t('adapters.target.unavailableHint')}</Alert>
				}
				<div class="ui-form__row">
					<Select
						id="adapters-instance"
						label={t('adapters.form.instance')}
						value={instanceId}
						disabled={saving}
						options={[
							{
								value: '',
								label: adapter?.recorded
									? t('adapters.instance.recorded')
									: t('adapters.instance.none'),
							},
							...instances.map(
								(instance) => ({
									value: instance.id,
									label: instance.name,
								}),
							),
							...(instanceId !== '' &&
							!instances.some((instance) => instance.id === instanceId)
								? [
										{ value: instanceId, label: instanceId },
									]
								: []),
						]}
						help={t('adapters.form.instanceHelp', {
							connector: adapter?.connector ?? '',
						})}
						onChange={setInstanceId}
					/>
					<FormField label={t('adapters.form.enabled')}>
						<Switch
							checked={enabled}
							label={t('adapters.form.enabled')}
							disabled={saving}
							onChange={setEnabled}
						/>
					</FormField>
				</div>
				@if (selected && !selected.allowWorkflows) {
					<Alert tone="warning">{t('adapters.form.consentHint')}</Alert>
				}
				<div class="ui-form__row">
					<Select
						id="adapters-schedule"
						label={t('adapters.form.schedule')}
						value={scheduleMode}
						disabled={saving}
						options={[
							{
								value: 'declared',
								label: adapter?.schedule
									? t('adapters.schedule.declared', { cron: adapter.schedule })
									: t('adapters.schedule.declaredNone'),
							},
							{ value: 'none', label: t('adapters.schedule.onDemand') },
							{ value: 'custom', label: t('adapters.schedule.custom') },
						]}
						onChange={(value) => setScheduleMode(value as ScheduleMode)}
					/>
					@if (scheduleMode === 'custom') {
						<FormField
							label={t('adapters.form.cron')}
							help={t('adapters.form.cronHelp')}
							required
						>
							<input
								class="ui-input ui-mono"
								value={cron}
								maxlength={100}
								placeholder="0 6 * * 1-5"
								disabled={saving}
								onInput={(event) => setCron(event.currentTarget.value)}
							/>
						</FormField>
					}
				</div>
				<section class="ui-form__section">
					<div class="ui-form__section-head">
						<b>{t('adapters.mapping.title')}</b>
						<small>
							{adapter?.direction === 'sink'
								? t('adapters.mapping.sinkHint')
								: t('adapters.mapping.sourceHint')}
						</small>
					</div>
					@if (drafts.length === 0) {
						<EmptyState icon="braces" title={t('adapters.mapping.empty')} />
					}
					@for (const entry of drafts; key entry.key) {
						<>
							<div class="ui-form__row">
								@if (fields.length > 0) {
									<Select
										id={'adapters-to-' + entry.key}
										label={t('adapters.mapping.to')}
										value={entry.to}
										disabled={saving}
										options={[
											{ value: '', label: t('adapters.mapping.choose') },
											...fields.map(
												(field) => ({
													value: field.id,
													label: field.required
														? `${field.label} *`
														: field.label,
												}),
											),
										]}
										onChange={(value) => update(entry.key, { to: value })}
									/>
								} @else {
									<FormField label={t('adapters.mapping.to')}>
										<input
											class="ui-input ui-mono"
											value={entry.to}
											maxlength={200}
											disabled={saving}
											onInput={(event) => update(entry.key, {
												to: event.currentTarget.value,
											})}
										/>
									</FormField>
								}
								<Select
									id={'adapters-transform-' + entry.key}
									label={t('adapters.mapping.transform')}
									value={entry.transform}
									disabled={saving}
									options={ADAPTER_TRANSFORMS.map(
										(transform) => ({
											value: transform,
											label: t('adapters.transform.' + transform),
										}),
									)}
									onChange={(value) => update(entry.key, {
										transform: value as AdapterTransform,
									})}
								/>
								@if (entry.transform !== 'constant') {
									@if (columns.length > 0) {
										<Select
											id={'adapters-from-' + entry.key}
											label={t('adapters.mapping.from')}
											value={entry.from}
											disabled={saving}
											options={[
												{ value: '', label: t('adapters.mapping.choose') },
												...columns.map(
													(column) => ({
														value: column.key,
														label: column.header,
													}),
												),
											]}
											onChange={(value) => update(entry.key, { from: value })}
										/>
									} @else {
										<FormField label={t('adapters.mapping.from')}>
											<input
												class="ui-input ui-mono"
												value={entry.from}
												maxlength={200}
												disabled={saving}
												onInput={(event) => update(entry.key, {
													from: event.currentTarget.value,
												})}
											/>
										</FormField>
									}
								}
								@if (entry.transform !== 'rename') {
									<FormField
										label={t('adapters.mapping.value.' + entry.transform)}
										help={entry.transform === 'format'
											? t('adapters.mapping.formatHelp')
											: undefined}
									>
										<input
											class="ui-input ui-mono"
											value={entry.value}
											maxlength={2000}
											disabled={saving}
											onInput={(event) => update(entry.key, {
												value: event.currentTarget.value,
											})}
										/>
									</FormField>
								}
								<Button
									size="sm"
									variant="ghost"
									disabled={saving}
									onClick={() => setDrafts(
										drafts.filter((other) => other.key !== entry.key),
									)}
								>
									<Icon name="x" size={14} />
									{t('adapters.mapping.remove')}
								</Button>
							</div>
							@if (entry.transform === 'lookup') {
								<FormField
									label={t('adapters.mapping.table')}
									help={t('adapters.mapping.tableHelp')}
								>
									<textarea
										class="ui-textarea ui-mono"
										value={entry.table}
										rows={4}
										disabled={saving}
										onInput={(event) => update(entry.key, {
											table: event.currentTarget.value,
										})}
									></textarea>
								</FormField>
							}
						</>
					}
					<div class="ui-form__actions">
						<Button
							size="sm"
							disabled={saving}
							onClick={() => setDrafts([...drafts, draftOf(null)])}
						>
							<Icon name="plus" size={14} />
							{t('adapters.mapping.add')}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={saving || !adapter}
							onClick={() => adapter && setDrafts(adapter.mapping.map(draftOf))}
						>{t('adapters.mapping.reset')}</Button>
					</div>
				</section>
				<section class="ui-form__section">
					<div class="ui-form__section-head">
						<b>{t('adapters.dryRun.title')}</b>
						<small>{t('adapters.dryRun.description')}</small>
					</div>
					<div class="ui-form__actions">
						<Button
							size="sm"
							disabled={previewing || saving}
							onClick={() => void runPreview()}
						>
							{previewing
								? t('adapters.dryRun.running')
								: t('adapters.dryRun.run')}
						</Button>
					</div>
					@if (previewError !== '') {
						<Alert>{previewError}</Alert>
					}
					@if (preview) {
						<Table
							caption={t('adapters.dryRun.caption', {
								read: preview.read,
								shown: preview.rows.length,
							})}
							columns={previewColumns()}
							rows={preview.rows}
							rowKey={(row) => String(row.index)}
							empty={{
								icon: 'search',
								title: t('adapters.dryRun.empty.title'),
								hint: t('adapters.dryRun.empty.hint'),
							}}
						/>
					}
				</section>
				@if (error !== '') {
					<Alert>{error}</Alert>
				}
			</div>
			<div class="ui-drawer__foot">
				<Button onClick={props.onClose}>{t('adapters.common.close')}</Button>
				<Button variant="primary" type="submit" disabled={saving || !adapter}>
					{saving ? t('adapters.common.saving') : t('adapters.form.save')}
				</Button>
			</div>
		</form>
	</Drawer>
}
