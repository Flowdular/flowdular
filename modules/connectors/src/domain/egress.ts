/**
 * The connectors egress policy offered to a module that opens a public URL of
 * its own, such as a page a research agent reads. It answers whether the URL
 * may be reached and, when it may, the only addresses a connection may dial:
 * `lookup` answers those addresses and nothing else, so a name that resolves
 * publicly for the check and privately a moment later is never reached.
 */
export const CONNECTORS_EGRESS_CAPABILITY = 'connectors.egress.v1';

export type ConnectorEgressRefusal =
	| 'CONNECTOR_URL_INVALID'
	| 'CONNECTOR_URL_BLOCKED'
	| 'CONNECTOR_PORT_REFUSED'
	| 'CONNECTOR_HOST_UNRESOLVED'
	| 'CONNECTOR_HOST_RESOLVES_PRIVATE';

/** The `lookup` option `node:https` takes for an agent or a request. */
export type ConnectorEgressLookup = (
	hostname: string,
	options: { readonly all?: boolean | undefined },
	callback: (
		error: Error | null,
		address: string | { address: string; family: number }[],
		family?: number,
	) => void,
) => void;

export type ConnectorEgressCheck =
	| {
			readonly ok: true;
			/** The normalized URL the check accepted. */
			readonly url: string;
			readonly addresses: readonly string[];
			readonly lookup: ConnectorEgressLookup;
	  }
	| { readonly ok: false; readonly reason: ConnectorEgressRefusal };

export interface ConnectorEgressCapability {
	/**
	 * https only, on port 443, to a host name that is neither an address
	 * literal nor a local name, resolving to public addresses only. Resolved on
	 * every call and never cached, because the answer is only as good as the
	 * moment it was given.
	 */
	check(url: string): Promise<ConnectorEgressCheck>;
}
