import { useMemo } from 'octane';
import {
	Alert,
	Button,
	CheckGrid,
	ConfirmDialog,
	FormField,
	Switch,
	Tag,
} from '@flowdular/ui';
import { t } from '@flowdular/client';
import type { CheckGroup, CheckOption } from '@flowdular/ui';
import type { TenantMember } from '@flowdular/module-auth';
import {
	loadSessionCsrfToken,
	resetMemberMfa,
} from '@flowdular/module-auth/client';
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
	readonly onSetMembershipStatus: (status: 'active' | 'disabled') => void;
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
		() => createStore({
			scopes: cell<readonly string[]>(props.member.scopes),
			accessOpen: false,
			mfaOpen: false,
			mfaBusy: false,
			mfaError: '',
			mfaNotice: '',
		}),
		[props.member.accountId],
	);
	const [scopes, setScopes] = useValue(draft.state.scopes);
	const [accessOpen, setAccessOpen] = useValue(draft.state.accessOpen);
	const [mfaOpen, setMfaOpen] = useValue(draft.state.mfaOpen);
	const [mfaBusy, setMfaBusy] = useValue(draft.state.mfaBusy);
	const [mfaError, setMfaError] = useValue(draft.state.mfaError);
	const [mfaNotice, setMfaNotice] = useValue(draft.state.mfaNotice);
	const locked = props.member.role === 'owner' && !props.actorIsOwner;
	const groups = scopeGroups(props.grantableScopes);
	const scopesChanged =
		scopes.length !== props.member.scopes.length ||
			scopes.some((scope) => !props.member.scopes.includes(scope));

	/* The factor belongs to auth.core, so the reset goes straight to its
   administration route with a token read from the live session. */
	const resetMfa = async () => {
		setMfaBusy(true);
		setMfaError('');
		setMfaNotice('');
		try {
			await resetMemberMfa(
				props.member.accountId,
				await loadSessionCsrfToken(),
			);
			setMfaNotice(t('users.notice.mfaReset'));
			setMfaOpen(false);
		} catch (error) {
			setMfaError(
				error instanceof Error ? error.message : t('users.error.request'),
			);
		} finally {
			setMfaBusy(false);
		}
	};

	<div class="ui-drawer__form">
		<div class="ui-drawer__body">
			<div class="ui-form">
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
				@if (props.notice) {
					<Alert tone="info">{props.notice}</Alert>
				}
				@if (mfaError) {
					<Alert>{mfaError}</Alert>
				}
				@if (mfaNotice) {
					<Alert tone="info">{mfaNotice}</Alert>
				}
				@if (locked) {
					<Alert tone="warning">{t('users.member.ownerLocked')}</Alert>
				} @else if (props.isSelf) {
					<Alert tone="info">{t('users.member.selfLocked')}</Alert>
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
						<b>{t('users.member.scopes')}</b>
						<small>{t('users.member.scopesDescription')}</small>
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
						>{t('users.member.saveScopes')}</Button>
					</div>
				</div>
				<MemberAccessSection
					member={props.member}
					disabled={locked || props.busy || props.isSelf}
					onEnable={() => props.onSetMembershipStatus('active')}
					onRequestDisable={() => setAccessOpen(true)}
				/>
				@if (!props.isSelf) {
					<MemberSecuritySection
						member={props.member}
						passwordMinLength={props.passwordMinLength}
						disabled={locked || props.busy}
						mfaBusy={mfaBusy}
						onResetPassword={(event) => {
							event.preventDefault();
							props.onResetPassword(formValue(event, 'temporaryPassword'));
							(event.currentTarget as HTMLFormElement).reset();
						}}
						onResetMfa={() => setMfaOpen(true)}
						onRevokeSessions={props.onRevokeSessions}
						onRemove={props.onRemove}
					/>
				}
			</div>
		</div>
		<div class="ui-drawer__foot">
			<div class="ui-form__actions">
				<Button onClick={props.onClose}>{t('users.action.close')}</Button>
			</div>
		</div>
		<ConfirmDialog
			open={accessOpen}
			title={t('users.membership.confirmTitle', {
				name: props.member.displayName,
			})}
			confirmLabel={t('users.membership.disable')}
			busy={props.busy}
			onConfirm={() => {
				setAccessOpen(false);
				props.onSetMembershipStatus('disabled');
			}}
			onCancel={() => setAccessOpen(false)}
		>{t('users.membership.confirmDescription')}</ConfirmDialog>
		<ConfirmDialog
			open={mfaOpen}
			title={t('users.mfaReset.title')}
			confirmLabel={t('users.member.resetMfa')}
			busy={mfaBusy}
			onConfirm={() => void resetMfa()}
			onCancel={() => setMfaOpen(false)}
		>{t('users.mfaReset.description', {
			name: props.member.displayName,
		})}</ConfirmDialog>
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
			<b>{t('users.member.identity')}</b>
			<small>{t('users.member.identityDescription')}</small>
		</div>
		<FormField label={t('users.form.displayName')} required>
			<input
				class="ui-input"
				name="displayName"
				minlength={2}
				maxlength={80}
				value={props.member.displayName}
				disabled={props.disabled}
				required
			/>
		</FormField>
		<FormField label={t('users.form.email')}>
			<input class="ui-input" value={props.member.email} disabled />
		</FormField>
		<div class="ui-form__actions">
			<Button size="sm" type="submit" disabled={props.disabled}>{t(
				'users.member.saveName',
			)}</Button>
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
			<b>{t('users.form.role')}</b>
			<small>{t('users.member.roleDescription')}</small>
		</div>
		<FormField label={t('users.form.role')}>
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
			<Button size="sm" type="submit" disabled={props.disabled}>{t(
				'users.member.assignRole',
			)}</Button>
		</div>
	</form>
}

/* Workspace access, not the operator's global block: the switch writes the
   membership alone, so the person keeps every other workspace. Turning it off
   is confirmed by the drawer; turning it back on is not, because it restores
   nothing that was revoked. */
function MemberAccessSection(props: {
	readonly member: TenantMember;
	readonly disabled: boolean;
	readonly onEnable: () => void;
	readonly onRequestDisable: () => void;
}) @{
	const active = props.member.membershipStatus === 'active';
	<div class="ui-form__section">
		<div class="ui-form__section-head">
			<b>{t('users.member.access')}</b>
			<small>{t('users.member.accessDescription')}</small>
		</div>
		<div class="ui-form__actions">
			<Switch
				checked={active}
				label={t('users.member.access')}
				disabled={props.disabled}
				onChange={(next) => next ? props.onEnable() : props.onRequestDisable()}
			/>
			<Tag tone={active ? 'success' : 'neutral'} dot>
				{active ? t('users.membership.active') : t('users.membership.disabled')}
			</Tag>
		</div>
		<small class="ui-help">
			{active
				? t('users.membership.reasonActive')
				: t('users.membership.reasonDisabled')}
		</small>
	</div>
}

function MemberSecuritySection(props: {
	readonly member: TenantMember;
	readonly passwordMinLength: number;
	readonly disabled: boolean;
	readonly mfaBusy: boolean;
	readonly onResetPassword: (event: SubmitEvent) => void;
	readonly onResetMfa: () => void;
	readonly onRevokeSessions: () => void;
	readonly onRemove: () => void;
}) @{
	<>
		<div class="ui-form__section">
			<div class="ui-form__section-head">
				<b>{t('users.member.account')}</b>
				<small>{t('users.member.accountDescription')}</small>
			</div>
			<div class="ui-form__actions">
				<Tag tone={props.member.status === 'active' ? 'success' : 'danger'} dot>
					{props.member.status === 'active'
						? t('users.status.active')
						: t('users.status.blocked')}
				</Tag>
				<Button
					size="sm"
					disabled={props.disabled}
					onClick={props.onRevokeSessions}
				>{t('users.member.signOutEverywhere')}</Button>
			</div>
			<small class="ui-help">{t('users.member.accountReadOnly')}</small>
		</div>
		<form class="ui-form__section" onSubmit={props.onResetPassword}>
			<div class="ui-form__section-head">
				<b>{t('users.member.temporaryPassword')}</b>
				<small>{t('users.member.temporaryPasswordHelp', {
					min: props.passwordMinLength,
				})}</small>
			</div>
			<div class="ui-control-row">
				<input
					class="ui-input"
					name="temporaryPassword"
					type="password"
					aria-label={t('users.member.temporaryPassword')}
					minlength={props.passwordMinLength}
					autocomplete="new-password"
					disabled={props.disabled}
					required
				/>
				<Button type="submit" disabled={props.disabled}>{t(
					'users.member.resetPassword',
				)}</Button>
			</div>
		</form>
		<div class="ui-form__section">
			<div class="ui-form__section-head">
				<b>{t('users.member.mfa')}</b>
				<small>{t('users.member.mfaDescription')}</small>
			</div>
			<div class="ui-form__actions">
				<Button
					size="sm"
					disabled={props.disabled || props.mfaBusy}
					onClick={props.onResetMfa}
				>{t('users.member.resetMfa')}</Button>
			</div>
		</div>
		<div class="ui-form__section ui-form__section--danger">
			<div class="ui-form__section-head">
				<b>{t('users.member.removeTitle')}</b>
				<small>{t('users.member.removeDescription')}</small>
			</div>
			<div class="ui-form__actions">
				<Button
					size="sm"
					variant="danger"
					disabled={props.disabled}
					onClick={props.onRemove}
				>{t('users.member.remove')}</Button>
			</div>
		</div>
	</>
}
