import { useMemo } from 'octane';
import { Alert, Button, CheckGrid, FormField } from '@coreloom/ui';
import { t } from '@coreloom/client';
import type { CheckGroup, CheckOption } from '@coreloom/ui';
import type { TenantRole } from '@coreloom/module-auth';
import { cell, createStore, useValue } from 'segment-state';
import type { RoleDraft } from './roles-api.ts';

export interface RoleFormProps {
	readonly role: TenantRole | null;
	readonly grantableScopes: readonly string[];
	readonly busy: boolean;
	readonly error: string;
	readonly onCancel: () => void;
	readonly onSubmit: (draft: RoleDraft) => void;
}

function scopeGroups(scopes: readonly string[]): readonly CheckGroup[] {
	const groups = new Map<string, CheckOption[]>();
	for (const scope of scopes) {
		const namespace = scope.split('.')[0] ?? scope;
		const options = groups.get(namespace) ?? [];
		options.push({
			value: scope,
			label: scope.slice(namespace.length + 1) || scope,
		});
		groups.set(namespace, options);
	}
	return [...groups].map(([label, options]) => ({ label, options }));
}

function field(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value.trim() : '';
}

export function RoleForm(props: RoleFormProps) @{
	const draft = useMemo(
		() => createStore({
			scopes: cell<readonly string[]>(props.role?.scopes ?? []),
		}),
		[],
	);
	const [scopes, setScopes] = useValue(draft.state.scopes);
	const editing = props.role !== null;

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		props.onSubmit({
			key: props.role?.key ?? field(form, 'key'),
			name: field(form, 'name'),
			description: field(form, 'description'),
			scopes,
		});
	};

	<form class="ui-drawer__form" onSubmit={submit}>
		<div class="ui-drawer__body">
			<div class="ui-form">
				<FormField
					label={t('users.roleForm.key')}
					help={t('users.roleForm.keyHelp')}
					required
				>
					<input
						class="ui-input ui-mono"
						name="key"
						pattern="[a-z][a-z0-9-]{1,31}"
						minlength={2}
						maxlength={32}
						value={props.role?.key ?? ''}
						disabled={editing}
						autoFocus={!editing}
						required
					/>
				</FormField>
				<FormField label={t('users.roleForm.name')} required>
					<input
						class="ui-input"
						name="name"
						minlength={2}
						maxlength={60}
						value={props.role?.name ?? ''}
						autoFocus={editing}
						required
					/>
				</FormField>
				<FormField label={t('users.roleForm.description')}>
					<input
						class="ui-input"
						name="description"
						maxlength={240}
						value={props.role?.description ?? ''}
					/>
				</FormField>
				<div class="ui-field">
					<span class="ui-label">
						{t('users.member.scopes')}
						<em aria-hidden="true">{' *'}</em>
					</span>
					<CheckGrid
						groups={scopeGroups(props.grantableScopes)}
						value={scopes}
						mono
						onChange={setScopes}
					/>
					<span class="ui-help">{t('users.roleForm.scopeCount', {
						selected: scopes.length,
						total: props.grantableScopes.length,
					})}</span>
				</div>
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<small>
				{editing
					? t('users.roleForm.editNote')
					: t('users.roleForm.createNote')}
			</small>
			<div class="ui-form__actions">
				<Button onClick={props.onCancel}>{t('users.action.cancel')}</Button>
				<Button
					variant="primary"
					type="submit"
					disabled={props.busy || scopes.length === 0}
				>
					{props.busy
						? t('users.action.saving')
						: editing
							? t('users.roleForm.save')
							: t('users.roleForm.create')}
				</Button>
			</div>
		</div>
	</form>
}
