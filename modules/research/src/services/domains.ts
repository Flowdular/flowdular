/** A rule names the host itself and every subdomain below it. */
function matches(host: string, rule: string): boolean {
	return host === rule || host.endsWith('.' + rule);
}

/** Deny wins; a non-empty allow list admits only the hosts it names. */
export function domainAdmitted(
	hostname: string,
	allow: readonly string[],
	deny: readonly string[],
): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, '');
	if (host === '') return false;
	if (deny.some((rule) => matches(host, rule))) return false;
	return allow.length === 0 || allow.some((rule) => matches(host, rule));
}

export function siteAdmits(hostname: string, site: string | null): boolean {
	return site === null || matches(hostname.toLowerCase(), site);
}
