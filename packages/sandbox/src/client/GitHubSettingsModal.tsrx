import { useState } from 'octane';
import { Alert, Button, Drawer, FormField } from '@flowdular/ui';
import { githubSettingsInput } from './github-settings.ts';
import type { SafeSandboxConfiguration } from '../server/config.ts';
import { useTranslation } from './i18n.ts';

export interface GitHubSettingsInput {
	readonly githubEnabled: boolean;
	readonly githubOverridesProject: boolean;
	readonly githubRemote: string;
	readonly githubRepository: string;
	readonly githubBaseBranch: string;
	readonly githubBranchPrefix: string;
	readonly githubMode: 'auto' | 'direct' | 'fork';
	readonly githubForkOwner: string;
	readonly githubReviewers: readonly string[];
	readonly githubToken?: string;
	readonly githubClearToken?: boolean;
}

export interface GitHubSettingsModalProps {
	readonly configuration: SafeSandboxConfiguration;
	readonly busy: boolean;
	readonly error: string;
	readonly onSave: (input: GitHubSettingsInput) => void;
	readonly onClose: () => void;
}

export function GitHubSettingsModal(props: GitHubSettingsModalProps) @{
	const { t } = useTranslation();
	const github = props.configuration.github;
	const [enabled, setEnabled] = useState(github.enabled);
	const [custom, setCustom] = useState(github.overridesProject);
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		props.onSave(
			githubSettingsInput(
				new FormData(event.currentTarget as HTMLFormElement),
				github,
			),
		);
	};

	<Drawer
		open={true}
		title={t('sandbox.github.title')}
		subtitle={t('sandbox.github.description')}
		width="lg"
		onClose={() => {
			if (!props.busy) props.onClose();
		}}
	>
		<form class="ui-drawer__form" onSubmit={submit}>
			<div class="ui-drawer__body">
				<div class="ui-form">
					<label class="ui-checkbox">
						<input
							type="checkbox"
							name="githubEnabled"
							checked={enabled}
							onChange={(event) => setEnabled(event.currentTarget.checked)}
						/>
						<span>{t('sandbox.github.offer')}</span>
					</label>
					<Alert tone="info">{t('sandbox.github.safety')}</Alert>
					<label class="ui-checkbox">
						<input
							type="checkbox"
							name="githubOverridesProject"
							checked={custom}
							onChange={(event) => setCustom(event.currentTarget.checked)}
						/>
						<span>{t('sandbox.github.overrideProject')}</span>
					</label>
					@if (!custom) {
						<p class="ui-help">{t('sandbox.github.projectHelp')}</p>
					} @else {
						<div class="ui-form__section">
							<FormField
								label={t('sandbox.github.repository.label')}
								help={t('sandbox.github.repository.help')}
							>
								<input
									class="ui-input ui-mono"
									name="githubRepository"
									defaultValue={github.repository ?? ''}
									placeholder={t('sandbox.github.repository.placeholder')}
									maxlength={200}
								/>
							</FormField>
							<FormField
								label={t('sandbox.github.mode.label')}
								help={t('sandbox.github.mode.help')}
							>
								<select
									class="ui-select"
									name="githubMode"
									defaultValue={github.mode}
								>
									<option value="auto">{t('sandbox.github.mode.auto')}</option>
									<option value="direct">{t(
										'sandbox.github.mode.direct',
									)}</option>
									<option value="fork">{t('sandbox.github.mode.fork')}</option>
								</select>
							</FormField>
							<FormField
								label={t('sandbox.github.reviewers.label')}
								help={t('sandbox.github.reviewers.help')}
							>
								<input
									class="ui-input ui-mono"
									name="githubReviewers"
									defaultValue={github.reviewers.join(', ')}
									maxlength={1000}
								/>
							</FormField>
							<details>
								<summary class="ui-label">{t(
									'sandbox.github.advanced',
								)}</summary>
								<div class="ui-form">
									<div class="ui-form__row">
										<FormField
											label={t('sandbox.github.remote.label')}
											help={t('sandbox.github.remote.help')}
										>
											<input
												class="ui-input ui-mono"
												name="githubRemote"
												defaultValue={github.remote}
												maxlength={120}
											/>
										</FormField>
										<FormField
											label={t('sandbox.github.base.label')}
											help={t('sandbox.github.base.help')}
										>
											<input
												class="ui-input ui-mono"
												name="githubBaseBranch"
												defaultValue={github.baseBranch}
												maxlength={120}
											/>
										</FormField>
									</div>
									<div class="ui-form__row">
										<FormField label={t('sandbox.github.prefix.label')}>
											<input
												class="ui-input ui-mono"
												name="githubBranchPrefix"
												defaultValue={github.branchPrefix}
												maxlength={120}
											/>
										</FormField>
										<FormField
											label={t('sandbox.github.forkOwner.label')}
											help={t('sandbox.github.forkOwner.help')}
										>
											<input
												class="ui-input ui-mono"
												name="githubForkOwner"
												defaultValue={github.forkOwner ?? ''}
												maxlength={120}
											/>
										</FormField>
									</div>
								</div>
							</details>
						</div>
					}
					<div class="ui-form__section">
						<div class="ui-form__section-head">
							<b>{t('sandbox.github.access')}</b>
							<small>{t('sandbox.github.accessHelp')}</small>
						</div>
						<FormField
							label={t('sandbox.github.token.label')}
							help={github.tokenFingerprint
								? t('sandbox.github.token.stored', {
										fingerprint: github.tokenFingerprint,
									})
								: t('sandbox.github.token.help')}
						>
							<input
								class="ui-input ui-mono"
								name="githubToken"
								type="password"
								autocomplete="new-password"
								placeholder={t('sandbox.github.token.placeholder')}
								maxlength={16384}
							/>
						</FormField>
						@if (github.tokenFingerprint) {
							<label class="ui-checkbox">
								<input type="checkbox" name="githubClearToken" />
								<span>{t('sandbox.github.token.remove')}</span>
							</label>
						}
					</div>
					@if (props.error) {
						<Alert>{props.error}</Alert>
					}
				</div>
			</div>
			<div class="ui-drawer__foot">
				<small>{t('sandbox.github.saveNote')}</small>
				<div class="ui-form__actions">
					<Button onClick={props.onClose} disabled={props.busy}>{t(
						'sandbox.common.cancel',
					)}</Button>
					<Button type="submit" variant="primary" disabled={props.busy}>
						{props.busy ? t('sandbox.common.saving') : t('sandbox.github.save')}
					</Button>
				</div>
			</div>
		</form>
	</Drawer>
}
