import { describe, expect, it } from 'vitest';
import { githubSettingsInput } from '../src/client/github-settings.ts';
import { DEFAULT_GITHUB_CONFIGURATION } from '../src/server/config.ts';

const current = {
	...DEFAULT_GITHUB_CONFIGURATION,
	remote: 'upstream',
	repository: 'team/app',
	baseBranch: 'develop',
	mode: 'fork' as const,
	forkOwner: 'alice',
	reviewers: ['reviewer'],
	tokenFingerprint: 'stored',
};

describe('delivery settings drawer', () => {
	it('preserves hidden custom settings and credentials when using project settings', () => {
		const form = new FormData();
		form.set('githubEnabled', 'on');
		form.set('githubToken', '  ');
		const input = githubSettingsInput(form, current);
		expect(input).toEqual({
			githubEnabled: true,
			githubOverridesProject: false,
			githubRemote: 'upstream',
			githubRepository: 'team/app',
			githubBaseBranch: 'develop',
			githubBranchPrefix: 'sandbox',
			githubMode: 'fork',
			githubForkOwner: 'alice',
			githubReviewers: ['reviewer'],
		});
		expect(input).not.toHaveProperty('githubToken');
		expect(input).not.toHaveProperty('githubClearToken');
	});
	it('submits edited visible and advanced fields', () => {
		const form = new FormData();
		form.set('githubEnabled', 'on');
		form.set('githubOverridesProject', 'on');
		form.set('githubRepository', ' new/project ');
		form.set('githubMode', 'auto');
		form.set('githubReviewers', ' anna, bob, , ');
		form.set('githubBaseBranch', 'main');
		form.set('githubToken', 'example-new-secret');
		const input = githubSettingsInput(form, current);
		expect(input).toMatchObject({
			githubOverridesProject: true,
			githubRepository: 'new/project',
			githubMode: 'auto',
			githubReviewers: ['anna', 'bob'],
			githubBaseBranch: 'main',
			githubToken: 'example-new-secret',
		});
	});
	it('clears the stored token only when explicitly selected', () => {
		const form = new FormData();
		form.set('githubClearToken', 'on');
		expect(githubSettingsInput(form, current)).toMatchObject({
			githubEnabled: false,
			githubClearToken: true,
		});
	});
});
