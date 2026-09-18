import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	Drawer,
	EmptyState,
	Icon,
	PageHeader,
	SearchField,
	TableCard,
	Tag,
} from '@flowdular/ui';
import { activeLocale, t } from '@flowdular/client';
import { cell, createStore, useValue } from 'segment-state';
import { ApiError } from './api.ts';
import {
	curlExample,
	loadApiDescription,
	type ApiDescription,
	type ApiOperation,
} from './api-docs.ts';
import { apiOperationColumns, methodTone } from './api-docs-columns.tsrx';

const EMPTY: ApiDescription = {
	title: '',
	version: '',
	serverUrl: '',
	operations: [],
};

function schemaText(schema: unknown): string {
	return JSON.stringify(schema, null, 2);
}

export function ApiDocsView() @{
	const client = useMemo(
		() => createStore({
			description: cell<ApiDescription>(EMPTY),
			status: cell<'loading' | 'idle' | 'error' | 'denied'>('loading'),
			error: '',
			query: '',
			selectedId: '',
		}),
		[],
	);
	const [description, setDescription] = useValue(client.state.description);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [query, setQuery] = useValue(client.state.query);
	const [selectedId, setSelectedId] = useValue(client.state.selectedId);

	const term = query.trim().toLocaleLowerCase(activeLocale());
	const visible =
		term === ''
			? description.operations
			: description.operations.filter(
					(operation) => (operation.path + ' ' + operation.method + ' ' +
						operation.summary +
						' ' +
						operation.moduleId +
						' ' +
						(operation.permission ?? '')).toLocaleLowerCase(
						activeLocale(),
					).includes(term),
				);
	const selected: ApiOperation | null =
		description.operations.find(
			(operation) => operation.id === selectedId,
		) ?? null;

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			setDescription(await loadApiDescription());
			setStatus('idle');
		} catch (loadError) {
			const denied =
				loadError instanceof ApiError &&
					(loadError.status === 401 || loadError.status === 403);
			setError(
				loadError instanceof Error
					? loadError.message
					: t('system.api.error.load'),
			);
			setStatus(denied ? 'denied' : 'error');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	<div class="ui-view">
		<PageHeader
			eyebrow={t('system.api.page.eyebrow')}
			title={t('system.api.page.title')}
			description={t('system.api.page.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('system.action.refresh')}
			</Button>
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('system.api.denied.title')}>{t(
					'system.api.denied.hint',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (status === 'error') {
					<Alert>{error}</Alert>
				}
				<Alert tone="info">{t('system.api.scopeNotice', {
					url: description.serverUrl || '/api',
				})}</Alert>
				<TableCard
					title={t('system.api.table.title')}
					count={t('system.api.table.count', {
						count: description.operations.length,
					})}
					search={<SearchField
						value={query}
						placeholder={t('system.api.search.placeholder')}
						label={t('system.api.search.label')}
						onInput={setQuery}
					/>}
					caption={t('system.api.table.caption')}
					columns={apiOperationColumns()}
					rows={visible}
					rowKey={(operation) => operation.id}
					status={status === 'loading' && description.operations.length === 0
						? 'loading'
						: 'idle'}
					loadingLabel={t('system.api.table.loading')}
					filtered={term !== ''}
					empty={{
						icon: 'modules',
						title: t('system.api.table.emptyTitle'),
						hint: t('system.api.table.emptyHint'),
					}}
					emptyFiltered={{
						icon: 'modules',
						title: t('system.api.table.emptyFilteredTitle'),
						hint: t('system.api.table.emptyFilteredHint'),
					}}
					onSelect={(operation) => setSelectedId(operation.id)}
				/>
			</>
		}
		<Drawer
			open={selected !== null}
			title={selected?.summary ?? ''}
			subtitle={selected === null ? '' : selected.method + ' ' + selected.path}
			width="lg"
			onClose={() => setSelectedId('')}
		>
			@if (selected !== null) {
				<div class="ui-drawer__body">
					<div class="ui-form">
						<div class="ui-form__section">
							<div class="ui-form__section-head">
								<b>{t('system.api.section.overview')}</b>
								<small>{selected.description}</small>
							</div>
							<div class="ui-control-row">
								<Tag tone={methodTone(selected.method)}>{selected.method}</Tag>
								<Tag tone="neutral" mono>{selected.moduleId}</Tag>
								@if (selected.permission !== null) {
									<Tag tone="info" mono>{selected.permission}</Tag>
								}
								<Tag tone={selected.needsWriteToken ? 'warning' : 'neutral'}>{t(
									selected.needsWriteToken
										? 'system.api.access.writeToken'
										: 'system.api.access.readToken',
								)}</Tag>
								@if (!selected.documented) {
									<Tag tone="neutral">{t('system.api.undocumented')}</Tag>
								}
							</div>
						</div>
						@if (selected.parameters.length > 0) {
							<div class="ui-form__section">
								<div class="ui-form__section-head">
									<b>{t('system.api.section.parameters')}</b>
								</div>
								@for (const parameter of selected.parameters; key parameter.name) {
									<div class="ui-field">
										<span class="ui-label ui-mono">{parameter.name}</span>
										<span class="ui-help">
											{parameter.in +
												(parameter.required
													? ' · ' + t('system.api.required')
													: '') +
												(parameter.description === ''
													? ''
													: ' · ' + parameter.description)}
										</span>
									</div>
								}
							</div>
						}
						@if (selected.requestBody !== null) {
							<div class="ui-form__section">
								<div class="ui-form__section-head">
									<b>{t('system.api.section.body')}</b>
								</div>
								<pre class="ui-code">{schemaText(selected.requestBody)}</pre>
							</div>
						}
						<div class="ui-form__section">
							<div class="ui-form__section-head">
								<b>{t('system.api.section.responses')}</b>
							</div>
							@for (const response of selected.responses; key response.status) {
								<div class="ui-field">
									<span class="ui-label ui-mono">{response.status}</span>
									<span class="ui-help">{response.description}</span>
								</div>
							}
						</div>
						<div class="ui-form__section">
							<div class="ui-form__section-head">
								<b>{t('system.api.section.call')}</b>
								<small>{t('system.api.callHint')}</small>
							</div>
							<pre class="ui-code">{curlExample(
								selected,
								description.serverUrl,
							)}</pre>
						</div>
					</div>
				</div>
			}
		</Drawer>
	</div>
}
