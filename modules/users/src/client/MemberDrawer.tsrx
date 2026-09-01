import { useMemo } from 'octane';
import { Alert, Button, CheckGrid, FormField, Tag } from '@coreloom/ui';
import type { CheckGroup, CheckOption } from '@coreloom/ui';
import type { TenantMember } from '@coreloom/module-auth';
import { cell, createStore, useValue } from 'segment-state';
import type { UserDirectory } from '../services/users-service.ts';

export interface MemberDrawerProps {
	readonly member: TenantMember;
	readonly roles: UserDirectory['roles'];
	readonly grantableScopes: readonly string[];
	readonly isSelf: boolean;
	readonly actorIsOwner: boolean;
	readonly passwordMinLength: number;
	readonly busy: boolean;
	readonly error: string;
	readonly notice: string;
	readonly onRename: (displayName: string) => void;
	readonly onAssignRole: (role: string) => void;
	readonly onSetScopes: (scopes: readonly string[]) => void;
	readonly onSetStatus: (status: 'active' | 'disabled') => void;
	readonly onResetPassword: (temporaryPassword: string) => void;
	readonly onRevokeSessions: () => void;
	readonly onRemove: () => void;
	readonly onClose: () => void;
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

function formValue(event: SubmitEvent, key: string): string {
	const value = new FormData(event.currentTarget as HTMLFormElement).get(key);
	return typeof value === 'string' ? value : '';
}

/* One drawer per member: identity, role, exact scopes, then the security
   actions that end sessions or credentials. Owners cannot be edited by
   non-owners; the server enforces it, the drawer only explains it. */
export function MemberDrawer(props: MemberDrawerProps) @{
	const draft = useMemo(
		() => createStore({ scopes: cell<readonly string[]>(props.member.scopes) }),
		[props.member.accountId],
	);
	const [scopes, setScopes] = useValue(draft.state.scopes);
	const locked = props.member.role === 'owner' && !props.actorIsOwner;
	const groups = scopeGroups(props.grantableScopes);
	const scopesChanged =
		scopes.length !== props.member.scopes.length ||
			scopes.some((scope) => !props.member.scopes.includes(scope));

	<div class="ui-drawer__form">
		<div class="ui-drawer__body">
			<div class="ui-form">
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
				@if (props.notice) {
					<Alert tone="info">{props.notice}</Alert>
				}
				@if (locked) {
					<Alert tone="warning">
						Only an owner can change another owner.
					</Alert>
				} @else if (props.isSelf) {
					<Alert tone="info">
						Your own role, scopes, and status change through another owner.
					</Alert>
				}
				<MemberIdentitySection
					member={props.member}
					disabled={locked || props.busy}
					onSubmit={(event) => {
						event.preventDefault();
						props.onRename(formValue(event, 'displayName'));
					}}
				/>
				<MemberRoleSection
					member={props.member}
					roles={props.roles}
					canAssignOwner={props.actorIsOwner}
					disabled={locked || props.busy || props.isSelf}
					onSubmit={(event) => {
						event.preventDefault();
						props.onAssignRole(formValue(event, 'role'));
					}}
				/>
				<div class="ui-form__section">
					<div class="ui-form__section-head">
						<b>Scopes</b>
						<small>
							Exact scopes of this membership. Assigning a role replaces them.
						</small>
					</div>
					<CheckGrid
						groups={groups}
						value={scopes}
						mono
						disabled={locked || props.busy || props.isSelf}
						onChange={setScopes}
					/>
					<div class="ui-form__actions">
						<Button
							size="sm"
							variant="primary"
							disabled={locked || props.busy || props.isSelf || !scopesChanged}
							onClick={() => props.onSetScopes(scopes)}
						>
							Save scopes
						</Button>
					</div>
				</div>
				@if (!props.isSelf) {
					<MemberSecuritySection
						member={props.member}
						passwordMinLength={props.passwordMinLength}
						disabled={locked || props.busy}
						onSetStatus={props.onSetStatus}
						onResetPassword={(event) => {
							event.preventDefault();
							props.onResetPassword(formValue(event, 'temporaryPassword'));
							(event.currentTarget as HTMLFormElement).reset();
						}}
						onRevokeSessions={props.onRevokeSessions}
						onRemove={props.onRemove}
					/>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<div class="ui-form__actions">
				<Button onClick={props.onClose}>Close</Button>
			</div>
		</div>
	</div>
}

function MemberIdentitySection(props: {
	readonly member: TenantMember;
	readonly disabled: boolean;
	readonly onSubmit: (event: SubmitEvent) => void;
}) @{
	<form
		key={'identity-' + props.member.accountId + props.member.displayName}
		class="ui-form__section"
		onSubmit={props.onSubmit}
	>
		<div class="ui-form__section-head">
			<b>Identity</b>
			<small>The email is the sign-in id and cannot change here.</small>
		</div>
		<FormField label="Display name" required>
			<input
				class="ui-input"
				name="displayName"
				minLength={2}
				maxLength={80}
				value={props.member.displayName}
				disabled={props.disabled}
				required
			/>
		</FormField>
		<FormField label="Email">
			<input class="ui-input" value={props.member.email} disabled />
		</FormField>
		<div class="ui-form__actions">
			<Button size="sm" type="submit" disabled={props.disabled}>
				Save name
			</Button>
		</div>
	</form>
}

function MemberRoleSection(props: {
	readonly member: TenantMember;
	readonly roles: UserDirectory['roles'];
	readonly canAssignOwner: boolean;
	readonly disabled: boolean;
	readonly onSubmit: (event: SubmitEvent) => void;
}) @{
	<form
		key={'role-' + props.member.accountId + props.member.role}
		class="ui-form__section"
		onSubmit={props.onSubmit}
	>
		<div class="ui-form__section-head">
			<b>Role</b>
			<small>
				A role sets the scopes below; custom roles live on the Roles screen.
			</small>
		</div>
		<FormField label="Role">
			<select class="ui-select" name="role" disabled={props.disabled}>
				@for (const role of props.roles; key role.id) {
					@if (
						role.key !== 'owner' || props.canAssignOwner ||
							props.member.role === 'owner'
					) {
						<option
							value={role.key}
							selected={role.key === props.member.role}
						>{role.name}</option>
					}
				}
			</select>
		</FormField>
		<div class="ui-form__actions">
			<Button size="sm" type="submit" disabled={props.disabled}>
				Assign role
			</Button>
		</div>
	</form>
}

function MemberSecuritySection(props: {
	readonly member: TenantMember;
	readonly passwordMinLength: number;
	readonly disabled: boolean;
	readonly onSetStatus: (status: 'active' | 'disabled') => void;
	readonly onResetPassword: (event: SubmitEvent) => void;
	readonly onRevokeSessions: () => void;
	readonly onRemove: () => void;
}) @{
	<>
		<div class="ui-form__section">
			<div class="ui-form__section-head">
				<b>Account</b>
				<small>Disabling ends every session at once and blocks sign-in.</small>
			</div>
			<div class="ui-form__actions">
				<Tag
					tone={props.member.status === 'active' ? 'success' : 'neutral'}
					dot
				>
					{props.member.status === 'active' ? 'Active' : 'Disabled'}
				</Tag>
				@if (props.member.status === 'active') {
					<Button
						size="sm"
						disabled={props.disabled}
						onClick={() => props.onSetStatus('disabled')}
					>
						Disable account
					</Button>
				} @else {
					<Button
						size="sm"
						disabled={props.disabled}
						onClick={() => props.onSetStatus('active')}
					>
						Enable account
					</Button>
				}
				<Button
					size="sm"
					disabled={props.disabled}
					onClick={props.onRevokeSessions}
				>
					Sign out everywhere
				</Button>
			</div>
		</div>
		<form class="ui-form__section" onSubmit={props.onResetPassword}>
			<div class="ui-form__section-head">
				<b>Temporary password</b>
				<small>
					{'At least ' + props.passwordMinLength +
						' characters. The member picks a new one at the next sign-in.'}
				</small>
			</div>
			<div class="ui-control-row">
				<input
					class="ui-input"
					name="temporaryPassword"
					type="password"
					aria-label="Temporary password"
					minLength={props.passwordMinLength}
					autoComplete="new-password"
					disabled={props.disabled}
					required
				/>
				<Button type="submit" disabled={props.disabled}>
					Reset password
				</Button>
			</div>
		</form>
		<div class="ui-form__section ui-form__section--danger">
			<div class="ui-form__section-head">
				<b>Remove from workspace</b>
				<small>
					Ends the membership with its sessions and tokens; the account stays if
					it belongs to another workspace.
				</small>
			</div>
			<div class="ui-form__actions">
				<Button
					size="sm"
					variant="danger"
					disabled={props.disabled}
					onClick={props.onRemove}
				>
					Remove member
				</Button>
			</div>
		</div>
	</>
}
