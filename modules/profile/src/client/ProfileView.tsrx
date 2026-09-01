import { useEffect, useMemo } from 'octane';
import { Alert, Button, EmptyState, PageHeader } from '@coreloom/ui';
import { useValue } from 'segment-state';
import { changeOwnPassword, loadOwnProfile, updateOwnProfile } from './api.ts';
import { DisplayNameCard } from './DisplayNameCard.tsrx';
import { PasswordCard } from './PasswordCard.tsrx';
import { SessionsCard } from './SessionsCard.tsrx';
import { validatePasswordChange, type PasswordFormValues } from './password.ts';
import { createProfileClientState } from './state.ts';

export interface ProfileViewProps {
	readonly csrfToken: string;
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export function ProfileView(props: ProfileViewProps) @{
	const profileState = useMemo(() => createProfileClientState(), []);
	const [profile] = useValue(profileState.state.profile);
	const [loaded] = useValue(profileState.state.loaded);
	const [status] = useValue(profileState.state.status);
	const [displayName] = useValue(profileState.state.displayName);
	const [loadError] = useValue(profileState.state.loadError);
	const [profileError] = useValue(profileState.state.profileError);
	const [profileSuccess] = useValue(profileState.state.profileSuccess);
	const [passwordError] = useValue(profileState.state.passwordError);
	const [passwordSuccess] = useValue(profileState.state.passwordSuccess);

	const refresh = async () => {
		profileState.store.act((transaction) => {
			transaction.set(profileState.state.status, 'loading');
			transaction.set(profileState.state.loadError, '');
		}, 'profile/loading');
		try {
			const record = await loadOwnProfile();
			profileState.store.act((transaction) => {
				transaction.set(profileState.state.profile, record);
				transaction.set(
					profileState.state.displayName,
					record?.displayName ?? '',
				);
				transaction.set(profileState.state.loaded, true);
				transaction.set(profileState.state.status, 'idle');
			}, 'profile/loaded');
		} catch (error) {
			profileState.store.act((transaction) => {
				transaction.set(profileState.state.loaded, true);
				transaction.set(profileState.state.status, 'idle');
				transaction.set(
					profileState.state.loadError,
					errorMessage(error, 'Could not load your profile.'),
				);
			}, 'profile/load-failed');
		}
	};

	useEffect(() => {
		void refresh();
	}, []);

	const setDisplayName = (value: string) => {
		profileState.store.act((transaction) => {
			transaction.set(profileState.state.displayName, value);
			transaction.set(profileState.state.profileError, '');
			transaction.set(profileState.state.profileSuccess, '');
		}, 'profile/display-name-edited');
	};

	const saveDisplayName = async (value: string) => {
		profileState.store.act((transaction) => {
			transaction.set(profileState.state.status, 'saving-profile');
			transaction.set(profileState.state.profileError, '');
			transaction.set(profileState.state.profileSuccess, '');
		}, 'profile/save-started');
		try {
			const record = await updateOwnProfile(
				{ displayName: value },
				props.csrfToken,
			);
			profileState.store.act((transaction) => {
				transaction.set(profileState.state.profile, record);
				transaction.set(profileState.state.displayName, record.displayName);
				transaction.set(profileState.state.status, 'idle');
				transaction.set(
					profileState.state.profileSuccess,
					'Your display name was saved.',
				);
			}, 'profile/saved');
		} catch (error) {
			profileState.store.act((transaction) => {
				transaction.set(profileState.state.status, 'idle');
				transaction.set(
					profileState.state.profileError,
					errorMessage(error, 'Could not update your profile.'),
				);
			}, 'profile/save-failed');
		}
	};

	const savePassword = async (values: PasswordFormValues): Promise<boolean> => {
		const validation = validatePasswordChange(values);
		if (!validation.valid) {
			profileState.store.act((transaction) => {
				transaction.set(profileState.state.passwordError, validation.message);
				transaction.set(profileState.state.passwordSuccess, '');
			}, 'profile/password-invalid');
			return false;
		}
		profileState.store.act((transaction) => {
			transaction.set(profileState.state.status, 'saving-password');
			transaction.set(profileState.state.passwordError, '');
			transaction.set(profileState.state.passwordSuccess, '');
		}, 'profile/password-save-started');
		try {
			await changeOwnPassword(validation.input, props.csrfToken);
			profileState.store.act((transaction) => {
				transaction.set(profileState.state.status, 'idle');
				transaction.set(
					profileState.state.passwordSuccess,
					'Your password was changed.',
				);
			}, 'profile/password-saved');
			return true;
		} catch (error) {
			profileState.store.act((transaction) => {
				transaction.set(profileState.state.status, 'idle');
				transaction.set(
					profileState.state.passwordError,
					errorMessage(error, 'Could not change your password.'),
				);
			}, 'profile/password-save-failed');
			return false;
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow="Workspace account"
			title="Profile"
			description="Your display name, password, and signed-in sessions."
		/>
		@if (status === 'loading' && !loaded) {
			<section class="ui-card">
				<p class="ui-table__empty">Loading your profile…</p>
			</section>
		} @else {
			@if (loadError && !profile) {
				<>
					<Alert>{loadError}</Alert>
					<div class="ui-form__actions">
						<Button onClick={() => void refresh()}>Try again</Button>
					</div>
				</>
			} @else {
				<>
					@if (loadError) {
						<Alert>{loadError}</Alert>
					} @else if (!profile) {
						<EmptyState title="No display name saved">
							Save a display name to create your workspace profile.
						</EmptyState>
					}
					<DisplayNameCard
						displayName={displayName}
						saving={status === 'saving-profile'}
						error={profileError}
						success={profileSuccess}
						onDisplayNameChange={setDisplayName}
						onSubmit={saveDisplayName}
					/>
					<PasswordCard
						saving={status === 'saving-password'}
						error={passwordError}
						success={passwordSuccess}
						onSubmit={savePassword}
					/>
					<SessionsCard csrfToken={props.csrfToken} />
				</>
			}
		}
	</div>
}
