import { isAiProviderKind, AI_PROVIDER_CATALOG } from '@flowdular/ai-provider';
import { sealSecret, type ByokProviderConfiguration } from './config.ts';
import { SandboxSetupError } from './workspace-root.ts';

export async function byokSettings(
	root: string,
	value: Record<string, unknown>,
	previous: ByokProviderConfiguration | null,
): Promise<ByokProviderConfiguration | null | undefined> {
	if (value.byokRemove === true) return null;
	if (value.byokKind === undefined) return undefined;
	const field = (name: string, max: number): string => {
		const valueAt = value[name];
		if (valueAt === undefined || valueAt === null) return '';
		if (typeof valueAt !== 'string' || valueAt.length > max)
			throw new SandboxSetupError('INVALID_INPUT', `Invalid ${name}.`);
		return valueAt.trim();
	};
	const kind = field('byokKind', 40);
	if (!isAiProviderKind(kind))
		throw new SandboxSetupError('INVALID_INPUT', 'Unknown AI provider.');
	const model = field('byokModel', 160);
	if (!model)
		throw new SandboxSetupError('INVALID_INPUT', 'A model is required.');
	const baseURL = field('byokBaseUrl', 2048);
	const resourceName = field('byokResourceName', 160);
	if (AI_PROVIDER_CATALOG[kind].requires.includes('baseURL') && !baseURL)
		throw new SandboxSetupError(
			'INVALID_INPUT',
			'An API base URL is required.',
		);
	if (
		AI_PROVIDER_CATALOG[kind].requires.includes('resourceName') &&
		!resourceName
	)
		throw new SandboxSetupError(
			'INVALID_INPUT',
			'An Azure resource name is required.',
		);
	if (baseURL) {
		let url: URL;
		try {
			url = new URL(baseURL);
		} catch {
			throw new SandboxSetupError('INVALID_INPUT', 'Invalid API base URL.');
		}
		if (
			!(
				url.protocol === 'https:' ||
				(url.protocol === 'http:' &&
					(url.hostname === 'localhost' ||
						url.hostname === '[::1]' ||
						/^127(?:\.\d{1,3}){3}$/.test(url.hostname)))
			) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			throw new SandboxSetupError(
				'INVALID_INPUT',
				'API base URL must use HTTPS (HTTP is allowed on loopback), without credentials, query or fragment.',
			);
	}
	const credential = field('byokCredential', 16384);
	const sameDestination =
		previous?.kind === kind &&
		(previous.baseURL ?? '') === baseURL &&
		(previous.resourceName ?? '') === resourceName;
	return {
		kind,
		model,
		...(baseURL ? { baseURL } : {}),
		...(resourceName ? { resourceName } : {}),
		credential: credential
			? await sealSecret(root, credential)
			: value.byokClearCredential === true || !sameDestination
				? null
				: (previous?.credential ?? null),
	};
}
