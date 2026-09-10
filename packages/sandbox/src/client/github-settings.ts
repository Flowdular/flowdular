import type { SafeSandboxConfiguration } from '../server/config.ts';
import type { GitHubSettingsInput } from './GitHubSettingsModal.tsrx';

/* Hidden custom fields must not erase the saved local settings when switching
   back to repository defaults. A blank credential preserves the sealed token. */
export function githubSettingsInput(
	form: FormData,
	current: SafeSandboxConfiguration['github'],
): GitHubSettingsInput {
	const value = (name: string, fallback = '') => {
		const entry = form.get(name);
		return typeof entry === 'string' ? entry.trim() : fallback;
	};
	const custom = form.get('githubOverridesProject') === 'on';
	const token = value('githubToken');
	return {
		githubEnabled: form.get('githubEnabled') === 'on',
		githubOverridesProject: custom,
		githubRemote: custom
			? value('githubRemote', current.remote)
			: current.remote,
		githubRepository: custom
			? value('githubRepository', current.repository ?? '')
			: (current.repository ?? ''),
		githubBaseBranch: custom
			? value('githubBaseBranch', current.baseBranch)
			: current.baseBranch,
		githubBranchPrefix: custom
			? value('githubBranchPrefix', current.branchPrefix)
			: current.branchPrefix,
		githubMode: custom
			? (value('githubMode', current.mode) as GitHubSettingsInput['githubMode'])
			: current.mode,
		githubForkOwner: custom
			? value('githubForkOwner', current.forkOwner ?? '')
			: (current.forkOwner ?? ''),
		githubReviewers: custom
			? value('githubReviewers', current.reviewers.join(','))
					.split(',')
					.map((entry) => entry.trim())
					.filter(Boolean)
			: current.reviewers,
		...(token ? { githubToken: token } : {}),
		...(form.get('githubClearToken') === 'on'
			? { githubClearToken: true }
			: {}),
	};
}
