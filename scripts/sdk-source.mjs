import members from './sdk-members.json' with { type: 'json' };

/** Rewrite only known internal package specifiers; business module identities stay stable. */
export function sdkSource(source) {
	return source.replace(/@flowdular\/[a-z0-9-]+/g, (name) =>
		members[name] ? `@flowdular/sdk/${members[name].export}` : name,
	);
}
export function sdkDependencies(pkg, version = '0.2.0') {
	for (const section of [
		'dependencies',
		'devDependencies',
		'peerDependencies',
		'optionalDependencies',
	]) {
		if (!pkg[section]) continue;
		let sdk = false;
		for (const name of Object.keys(pkg[section])) {
			if (members[name]) {
				delete pkg[section][name];
				sdk = true;
			}
			if (name === '@flowdular/cli') {
				delete pkg[section][name];
				pkg[section].flowdular = version;
			}
		}
		if (sdk) pkg[section]['@flowdular/sdk'] = version;
	}
	if (pkg.dependencies?.['@flowdular/sdk'])
		delete pkg.devDependencies?.['@flowdular/sdk'];
	return pkg;
}
