import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	EmptyState,
	Icon,
	PageHeader,
	ScopeSummary,
	Tag,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import type { TenantRole } from '@flowdular/module-auth';
import { cell, createStore, useValue } from 'segment-state';
import { ApiError } from './api.ts';
import { RoleForm } from './RoleForm.tsrx';
import {
	createRole,
	deleteRole,
	loadRoles,
	updateRole,
	type RoleDraft,
} from './roles-api.ts';

export interface RolesViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
}

type RolesStatus = 'loading' | 'idle' | 'submitting' | 'denied' | 'error';

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

function createRolesState() {
	const store = createStore({
		roles: cell<readonly TenantRole[]>([]),
		grantableScopes: cell<readonly string[]>([]),
		status: cell<RolesStatus>('loading'),
		error: '',
		editorOpen: false,
		editorSession: 0,
		editingId: cell<string | null>(null),
		deletingId: cell<string | null>(null),
	});
	return { store, state: store.state };
}

export function RolesView(props: RolesViewProps) @{
	const client = useMemo(() => createRolesState(), []);
	const [roles] = useValue(client.state.roles);
	const [grantableScopes] = useValue(client.state.grantableScopes);
	const [status, setStatus] = useValue(client.state.status);
	const [error, setError] = useValue(client.state.error);
	const [editorOpen, setEditorOpen] = useValue(client.state.editorOpen);
	const [editorSession, setEditorSession] = useValue(
		client.state.editorSession,
	);
	const [editingId, setEditingId] = useValue(client.state.editingId);
	const [deletingId, setDeletingId] = useValue(client.state.deletingId);
	const editing = roles.find((role) => role.id === editingId) ?? null;
	const deleting = roles.find((role) => role.id === deletingId) ?? null;
	const custom = roles.filter((role) => !role.builtin);

	const refresh = async () => {
		setStatus('loading');
		setError('');
		try {
			const catalog = await loadRoles();
			client.store.act((transaction) => {
				transaction.set(client.state.roles, catalog.roles);
				transaction.set(client.state.grantableScopes, catalog.grantableScopes);
				transaction.set(client.state.status, 'idle');
			}, 'roles/loaded');
		} catch (loadError) {
			setError(message(loadError, t('users.roles.errorLoad')));
			setStatus(
				loadError instanceof ApiError && loadError.status === 403
					? 'denied'
					: 'error',
			);
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const openEditor = (role: TenantRole | null) => {
		setError('');
		setEditingId(role?.id ?? null);
		setEditorSession((current) => current + 1);
		setEditorOpen(true);
	};

	const closeEditor = () => {
		setEditorOpen(false);
		setEditingId(null);
		setError('');
	};

	const submit = async (draft: RoleDraft) => {
		setStatus('submitting');
		setError('');
		try {
			const saved = editing
				? await updateRole(editing.id, draft, props.csrfToken)
				: await createRole(draft, props.csrfToken);
			client.store.act((transaction) => {
				transaction.set(client.state.roles, [
					...roles.filter((role) => role.id !== saved.id),
					saved,
				]);
				transaction.set(client.state.status, 'idle');
				transaction.set(client.state.editorOpen, false);
				transaction.set(client.state.editingId, null);
			}, 'roles/saved');
			await refresh();
		} catch (saveError) {
			setError(message(saveError, t('users.roles.errorSave')));
			setStatus('idle');
		}
	};

	const remove = async () => {
		if (!deleting) return;
		const id = deleting.id;
		setDeletingId(null);
		setStatus('submitting');
		setError('');
		try {
			await deleteRole(id, props.csrfToken);
			client.store.act((transaction) => {
				transaction.set(
					client.state.roles,
					roles.filter((role) => role.id !== id),
				);
				transaction.set(client.state.status, 'idle');
			}, 'roles/deleted');
		} catch (deleteError) {
			setError(message(deleteError, t('users.roles.errorDelete')));
			setStatus('idle');
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('users.page.eyebrow')}
			title={t('users.roles.title')}
			description={t('users.roles.description')}
		>
			<Button size="sm" onClick={() => void refresh()}>
				<Icon name="refresh" size={14} />
				{t('users.action.refresh')}
			</Button>
			@if (props.canManage) {
				<Button
					size="sm"
					variant="primary"
					disabled={status === 'denied' || grantableScopes.length === 0}
					onClick={() => openEditor(null)}
				>
					<Icon name="plus" size={14} />
					{t('users.roles.new')}
				</Button>
			}
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('users.denied.title')}>{t(
					'users.roles.denied',
				)}</EmptyState>
			</section>
		} @else if (status === 'loading' && roles.length === 0) {
			<section class="ui-card">
				<p class="ui-table__empty">{t('users.roles.loading')}</p>
			</section>
		} @else {
			<>
				@if (error && !editorOpen) {
					<Alert>{error}</Alert>
				}
				@if (roles.length === 0) {
					<section class="ui-card">
						<EmptyState icon="shield" title={t('users.roles.emptyTitle')}>{t(
							'users.roles.emptyHint',
						)}</EmptyState>
					</section>
				} @else {
					<div class="ui-grid-2">
						@for (const role of roles; key role.id) {
							<RoleCard
								role={role}
								canManage={props.canManage}
								busy={status === 'submitting'}
								onEdit={() => openEditor(role)}
								onDelete={() => setDeletingId(role.id)}
							/>
						}
					</div>
				}
				<section class="ui-card">
					<div class="ui-card__head">
						<span class="ui-card__title">
							{t('users.roles.customTitle')}
							<small>{t('users.roles.customCount', {
								count: custom.length,
							})}</small>
						</span>
					</div>
					<p class="ui-note">
						<Icon name="shield" size={14} />
						<span>{t('users.roles.note')}</span>
					</p>
				</section>
			</>
		}
		<Drawer
			open={editorOpen}
			title={editing ? t('users.roles.edit') : t('users.roles.new')}
			subtitle={editing ? editing.key : t('users.roles.drawerSubtitle')}
			width="lg"
			onClose={closeEditor}
		>
			<RoleForm
				key={'role-form-' + editorSession}
				role={editing}
				grantableScopes={grantableScopes}
				busy={status === 'submitting'}
				error={editorOpen ? error : ''}
				onCancel={closeEditor}
				onSubmit={(draft) => void submit(draft)}
			/>
		</Drawer>
		<ConfirmDialog
			open={deleting !== null}
			title={t('users.roles.deleteTitle', { name: deleting?.name ?? '' })}
			confirmLabel={t('users.roles.delete')}
			busy={status === 'submitting'}
			onConfirm={() => void remove()}
			onCancel={() => setDeletingId(null)}
		>{t('users.roles.deleteDescription')}</ConfirmDialog>
	</div>
}

/* The card summarizes the grant per module; the exact list is edited in the
   drawer's CheckGrid. */
function RoleCard(props: {
	readonly role: TenantRole;
	readonly canManage: boolean;
	readonly busy: boolean;
	readonly onEdit: () => void;
	readonly onDelete: () => void;
}) @{
	<section class="ui-card">
		<div class="ui-card__head">
			<span class="ui-card__title">
				{props.role.name}
				<small>{props.role.description || props.role.key}</small>
			</span>
			<span class="ui-card__actions">
				<Tag>{t('users.roles.scopeCount', {
					count: props.role.scopes.length,
				})}</Tag>
				@if (props.role.builtin) {
					<Tag>{t('users.roles.builtin')}</Tag>
				} @else if (props.canManage) {
					<>
						<Button size="sm" disabled={props.busy} onClick={props.onEdit}>{t(
							'users.action.edit',
						)}</Button>
						<Button
							size="sm"
							variant="danger"
							disabled={props.busy}
							onClick={props.onDelete}
						>{t('users.action.delete')}</Button>
					</>
				}
			</span>
		</div>
		<div class="ui-card__body">
			<ScopeSummary scopes={props.role.scopes} />
		</div>
	</section>
}
