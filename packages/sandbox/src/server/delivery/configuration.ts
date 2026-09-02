import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SandboxSetupError } from '../workspace-root.ts';
import type { DeliveryProvider, EjectTarget } from './types.ts';

export type GitPushMode = 'auto' | 'direct' | 'fork';

export interface GitDeliveryConfiguration {
	readonly remote: string;
	readonly repository: string | null;
	readonly baseBranch: string;
	readonly branchPrefix: string;
	readonly provider: DeliveryProvider;
	readonly mode: GitPushMode;
	readonly forkOwner: string | null;
	readonly reviewers: readonly string[];
}

/* The sandbox.delivery block of coreloom.json. Every field is optional there;
   this is the resolved shape the sandbox works with. */
export interface DeliveryConfiguration {
	readonly default: EjectTarget;
	readonly targets: readonly EjectTarget[];
	readonly git: GitDeliveryConfiguration;
	/* Overrides the task budget from .ai/policies/task-budgets.yaml when set. */
	readonly maxChangedFiles: number | null;
}

export const DEFAULT_DELIVERY_CONFIGURATION: DeliveryConfiguration = {
	default: 'workspace',
	targets: ['workspace', 'git-pr'],
	git: {
		remote: 'origin',
		repository: null,
		baseBranch: 'main',
		branchPrefix: 'sandbox',
		provider: 'github',
		mode: 'auto',
		forkOwner: null,
		reviewers: [],
	},
	maxChangedFiles: null,
};

const EJECT_TARGETS: readonly EjectTarget[] = ['workspace', 'git-pr'];
/* Remote, branch, and prefix become git arguments; a value that starts with a
   dash would be read as an option. */
const GIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_GIT_NAME_LENGTH = 120;
const MAX_GITHUB_REVIEWERS = 20;
const GITHUB_REPOSITORY =
	/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const GITHUB_ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function invalid(detail: string): SandboxSetupError {
	return new SandboxSetupError(
		'DELIVERY_CONFIG_INVALID',
		`coreloom.json sandbox.delivery is not usable: ${detail}`,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEjectTarget(value: unknown): value is EjectTarget {
	return typeof value === 'string' && EJECT_TARGETS.includes(value as never);
}

function gitName(value: unknown, fallback: string, field: string): string {
	if (value === undefined) return fallback;
	if (
		typeof value !== 'string' ||
		value.length > MAX_GIT_NAME_LENGTH ||
		!GIT_NAME.test(value)
	) {
		throw invalid(`git.${field} must be a plain git name.`);
	}
	return value;
}

export function resolveDeliveryConfiguration(
	block: unknown,
): DeliveryConfiguration {
	if (block === undefined) return DEFAULT_DELIVERY_CONFIGURATION;
	if (!isRecord(block)) throw invalid('it must be an object.');
	const defaults = DEFAULT_DELIVERY_CONFIGURATION;
	let targets = defaults.targets;
	if (block.targets !== undefined) {
		if (
			!Array.isArray(block.targets) ||
			block.targets.length === 0 ||
			!block.targets.every(isEjectTarget)
		) {
			throw invalid('targets must list workspace and/or git-pr.');
		}
		targets = [...new Set(block.targets)];
	}
	const fallback = block.default ?? defaults.default;
	if (!isEjectTarget(fallback) || !targets.includes(fallback)) {
		throw invalid('default must be one of the listed targets.');
	}
	const git = isRecord(block.git) ? block.git : {};
	if (block.git !== undefined && !isRecord(block.git)) {
		throw invalid('git must be an object.');
	}
	const provider = git.provider ?? defaults.git.provider;
	if (provider !== 'github' && provider !== 'none') {
		throw invalid('git.provider must be github or none.');
	}
	const mode = git.mode ?? defaults.git.mode;
	if (mode !== 'auto' && mode !== 'direct' && mode !== 'fork') {
		throw invalid('git.mode must be auto, direct, or fork.');
	}
	const repository = git.repository ?? defaults.git.repository;
	if (
		repository !== null &&
		(typeof repository !== 'string' || !GITHUB_REPOSITORY.test(repository))
	) {
		throw invalid('git.repository must use the owner/name form.');
	}
	const forkOwner = git.forkOwner ?? defaults.git.forkOwner;
	if (
		forkOwner !== null &&
		(typeof forkOwner !== 'string' || !GITHUB_ACCOUNT.test(forkOwner))
	) {
		throw invalid('git.forkOwner must be a GitHub account name.');
	}
	const reviewers = git.reviewers ?? defaults.git.reviewers;
	if (
		!Array.isArray(reviewers) ||
		reviewers.length > MAX_GITHUB_REVIEWERS ||
		!reviewers.every(
			(reviewer) =>
				typeof reviewer === 'string' && GITHUB_ACCOUNT.test(reviewer),
		)
	) {
		throw invalid('git.reviewers must list account names.');
	}
	const maxChangedFiles = block.maxChangedFiles ?? null;
	if (
		maxChangedFiles !== null &&
		(!Number.isInteger(maxChangedFiles) || (maxChangedFiles as number) < 1)
	) {
		throw invalid('maxChangedFiles must be a positive integer.');
	}
	return {
		default: fallback,
		targets,
		git: {
			remote: gitName(git.remote, defaults.git.remote, 'remote'),
			repository: repository as string | null,
			baseBranch: gitName(
				git.baseBranch,
				defaults.git.baseBranch,
				'baseBranch',
			),
			branchPrefix: gitName(
				git.branchPrefix,
				defaults.git.branchPrefix,
				'branchPrefix',
			),
			provider,
			mode,
			forkOwner: forkOwner as string | null,
			reviewers: reviewers as readonly string[],
		},
		maxChangedFiles: maxChangedFiles as number | null,
	};
}

/* Read at request time, so an operator who edits coreloom.json does not have
   to restart the sandbox for the delivery settings to apply. */
export async function readDeliveryConfiguration(
	workspaceRoot: string,
): Promise<DeliveryConfiguration> {
	let project: unknown;
	try {
		project = JSON.parse(
			await readFile(join(workspaceRoot, 'coreloom.json'), 'utf8'),
		);
	} catch {
		return DEFAULT_DELIVERY_CONFIGURATION;
	}
	const sandbox = isRecord(project) ? project.sandbox : undefined;
	return resolveDeliveryConfiguration(
		isRecord(sandbox) ? sandbox.delivery : undefined,
	);
}
