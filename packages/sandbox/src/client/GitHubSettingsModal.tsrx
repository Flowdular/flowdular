import { Alert, Button, FormField, Icon, Tag } from '@coreloom/ui';
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

function value(form: FormData, name: string): string {
	const entry = form.get(name);
	return typeof entry === 'string' ? entry.trim() : '';
}

function checked(form: FormData, name: string): boolean {
	return form.get(name) === 'on';
}

export function GitHubSettingsModal(props: GitHubSettingsModalProps) @{
	const { t } = useTranslation();
	const github = props.configuration.github;
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const token = value(form, 'githubToken');
		props.onSave({
			githubEnabled: checked(form, 'githubEnabled'),
			githubOverridesProject: checked(form, 'githubOverridesProject'),
			githubRemote: value(form, 'githubRemote'),
			githubRepository: value(form, 'githubRepository'),
			githubBaseBranch: value(form, 'githubBaseBranch'),
			githubBranchPrefix: value(form, 'githubBranchPrefix'),
			githubMode: value(form, 'githubMode') as 'auto' | 'direct' | 'fork',
			githubForkOwner: value(form, 'githubForkOwner'),
			githubReviewers: value(form, 'githubReviewers').split(',').map(
				(entry) => entry.trim(),
			).filter(Boolean),
			...(token ? { githubToken: token } : {}),
			...(checked(form, 'githubClearToken') ? { githubClearToken: true } : {}),
		});
	};

	<div class="workbench github-settings" role="dialog" aria-modal="true">
		<form class="github-settings__panel" onSubmit={submit}>
			<header class="github-settings__head">
				<span class="github-settings__title">
					<Icon name="code" size={18} />
					{t('sandbox.github.title')}
				</span>
				<span class="sandbox__spacer"></span>
				<Tag tone={github.enabled ? 'success' : 'neutral'} dot>
					{github.enabled
						? t('sandbox.github.enabled')
						: t('sandbox.github.disabled')}
				</Tag>
			</header>
			<div class="github-settings__body">
				<p class="ui-help">{t('sandbox.github.description')}</p>
				<label class="ui-checkbox">
					<input
						type="checkbox"
						name="githubEnabled"
						defaultChecked={github.enabled}
					/>
					<span>{t('sandbox.github.offer')}</span>
				</label>
				<label class="ui-checkbox">
					<input
						type="checkbox"
						name="githubOverridesProject"
						defaultChecked={github.overridesProject}
					/>
					<span>{t('sandbox.github.overrideProject')}</span>
				</label>
				<div class="ui-form__row">
					<FormField
						label={t('sandbox.github.remote.label')}
						help={t('sandbox.github.remote.help')}
						required
					>
						<input
							class="ui-input ui-mono"
							name="githubRemote"
							defaultValue={github.remote}
							required
						/>
					</FormField>
					<FormField
						label={t('sandbox.github.repository.label')}
						help={t('sandbox.github.repository.help')}
					>
						<input
							class="ui-input ui-mono"
							name="githubRepository"
							defaultValue={github.repository ?? ''}
							placeholder={t('sandbox.github.repository.placeholder')}
						/>
					</FormField>
				</div>
				<div class="ui-form__row">
					<FormField label={t('sandbox.github.base.label')} required>
						<input
							class="ui-input ui-mono"
							name="githubBaseBranch"
							defaultValue={github.baseBranch}
							required
						/>
					</FormField>
					<FormField label={t('sandbox.github.prefix.label')} required>
						<input
							class="ui-input ui-mono"
							name="githubBranchPrefix"
							defaultValue={github.branchPrefix}
							required
						/>
					</FormField>
				</div>
				<div class="ui-form__row">
					<FormField
						label={t('sandbox.github.mode.label')}
						help={t('sandbox.github.mode.help')}
						required
					>
						<select
							class="ui-select"
							name="githubMode"
							defaultValue={github.mode}
						>
							<option value="auto">{t('sandbox.github.mode.auto')}</option>
							<option value="direct">{t('sandbox.github.mode.direct')}</option>
							<option value="fork">{t('sandbox.github.mode.fork')}</option>
						</select>
					</FormField>
					<FormField
						label={t('sandbox.github.forkOwner.label')}
						help={t('sandbox.github.forkOwner.help')}
					>
						<input
							class="ui-input ui-mono"
							name="githubForkOwner"
							defaultValue={github.forkOwner ?? ''}
							placeholder={t('sandbox.github.forkOwner.placeholder')}
						/>
					</FormField>
				</div>
				<FormField
					label={t('sandbox.github.reviewers.label')}
					help={t('sandbox.github.reviewers.help')}
				>
					<input
						class="ui-input ui-mono"
						name="githubReviewers"
						defaultValue={github.reviewers.join(', ')}
					/>
				</FormField>
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
					/>
				</FormField>
				@if (github.tokenFingerprint) {
					<label class="ui-checkbox">
						<input type="checkbox" name="githubClearToken" />
						<span>{t('sandbox.github.token.remove')}</span>
					</label>
				}
				@if (props.error) {
					<Alert>{props.error}</Alert>
				}
			</div>
			<footer class="github-settings__foot">
				<Button
					type="button"
					size="sm"
					variant="ghost"
					onClick={props.onClose}
				>{t('sandbox.common.cancel')}</Button>
				<Button type="submit" size="sm" variant="primary" disabled={props.busy}>
					{props.busy ? t('sandbox.common.saving') : t('sandbox.github.save')}
				</Button>
			</footer>
		</form>
	</div>
}
