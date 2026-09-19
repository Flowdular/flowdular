/**
 * Every place that carries the release version, and the check that they agree.
 *
 * A release moves one number through a dozen files by hand. Miss the pin in the
 * scaffold and the generator ships a template that installs an SDK without the
 * exports its own composition imports, which no test sees: the consumer smoke
 * overrides the dependency with a packed artifact from this workspace, so it
 * proves the code works, never that the published version would.
 */

export interface VersionSite {
	readonly path: string;
	/** Named in the failure, so a reader knows what to edit. */
	readonly what: string;
	/** Capture group 1 is the version. */
	readonly pattern: RegExp;
}

export const ROOT_VERSION_SITE: VersionSite = {
	path: 'package.json',
	what: 'the workspace version',
	pattern: /"version":\s*"(\d[^"]*)"/,
};

export const RELEASE_VERSION_SITES: readonly VersionSite[] = Object.freeze([
	{
		path: 'packages/sdk/package.json',
		what: 'the SDK version',
		pattern: /"version":\s*"(\d[^"]*)"/,
	},
	{
		path: 'packages/cli/package.json',
		what: 'the CLI version',
		pattern: /"version":\s*"(\d[^"]*)"/,
	},
	{
		path: 'packages/create-flowdular/package.json',
		what: 'the generator version',
		pattern: /"version":\s*"(\d[^"]*)"/,
	},
	{
		path: 'packages/sandbox/package.json',
		what: 'the sandbox version',
		pattern: /"version":\s*"(\d[^"]*)"/,
	},
	{
		path: 'packages/cli/src/sdk.ts',
		what: 'SDK_VERSION, which the CLI writes into a scaffolded module',
		pattern: /SDK_VERSION\s*=\s*'([^']+)'/,
	},
	{
		path: 'packages/create-flowdular/template/default/package.json',
		what: 'the flowdular pin a generated application installs',
		pattern: /"flowdular":\s*"(\d[^"]*)"/,
	},
	{
		path: 'packages/create-flowdular/template/default/platform/package.json',
		what: 'the SDK pin a generated platform installs',
		pattern: /"@flowdular\/sdk":\s*"(\d[^"]*)"/,
	},
	{
		path: 'packages/create-flowdular/template/default/modules/example/package.json',
		what: 'the SDK pin the example module installs',
		pattern: /"@flowdular\/sdk":\s*"(\d[^"]*)"/,
	},
	{
		path: 'infra/kubernetes/deployment.yaml',
		what: 'the container image tag',
		pattern: /image:\s*ghcr\.io\/flowdular\/flowdular:(\S+)/,
	},
	{
		path: 'infra/kubernetes/kustomization.yaml',
		what: 'the kustomize image tag',
		pattern: /newTag:\s*(\S+)/,
	},
	{
		path: 'docs/npm-publication.md',
		what: 'the published versions this page states',
		pattern: /`([^`]+)`; the sandbox depends on SDK/,
	},
]);

export interface VersionFinding {
	readonly path: string;
	readonly message: string;
}

/**
 * The sites that do not carry `version`. A site whose pattern matches nothing
 * is a finding too: a file that moved on without this table is exactly how a
 * pin goes unnoticed.
 */
export function releaseVersionDrift(
	version: string,
	sources: ReadonlyMap<string, string>,
	sites: readonly VersionSite[] = RELEASE_VERSION_SITES,
): readonly VersionFinding[] {
	const findings: VersionFinding[] = [];
	for (const site of sites) {
		const source = sources.get(site.path);
		if (source === undefined) {
			findings.push({
				path: site.path,
				message: `${site.what} is missing; the file was not read.`,
			});
			continue;
		}
		const found = site.pattern.exec(source)?.[1];
		if (found === undefined) {
			findings.push({
				path: site.path,
				message: `${site.what} was not found. The file changed shape; fix the pattern in packages/cli/src/release-versions.ts.`,
			});
			continue;
		}
		if (found !== version) {
			findings.push({
				path: site.path,
				message: `${site.what} is ${found}, and the workspace is at ${version}.`,
			});
		}
	}
	return findings;
}
