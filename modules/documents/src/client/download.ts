/**
 * The part of a browser window this module uses to hand a reader a file. Named
 * as an interface so the behaviour can be exercised without one.
 */
export interface DownloadWindow {
	open(url: string, target: string): DownloadTab | null;
}

export interface DownloadTab {
	location: { href: string };
	opener: unknown;
	close(): void;
}

/** The tab a download was started in, before the URL that fills it exists. */
export interface DownloadTarget {
	/** Sends the waiting tab to the URL the server issued. */
	send(url: string): void;
	/** Closes it when no URL was issued, so no blank tab is left behind. */
	abort(): void;
}

/**
 * Opens the tab inside the click that asked for it. A tab opened after the
 * await that resolves the read URL is a pop-up the browser blocks, so the tab
 * is claimed first and sent to the URL when it arrives. `opener` is dropped as
 * soon as the tab exists: the download route must not reach back into the app.
 */
export function openDownloadTarget(
	view: DownloadWindow,
): DownloadTarget | null {
	const tab = view.open('', '_blank');
	if (!tab) return null;
	tab.opener = null;
	return {
		send(url) {
			tab.location.href = url;
		},
		abort() {
			tab.close();
		},
	};
}

/**
 * One download from the click to the bytes. The tab is claimed before `resolve`
 * runs and closed again when it refuses, and a window the browser would not
 * open is reported rather than passed over in silence.
 */
export async function runDownload(
	view: DownloadWindow,
	resolve: () => Promise<string>,
): Promise<void> {
	const target = openDownloadTarget(view);
	if (!target) throw new DownloadBlocked();
	try {
		target.send(await resolve());
	} catch (error) {
		target.abort();
		throw error;
	}
}

/** The browser refused the tab, so the reader has to allow it themselves. */
export class DownloadBlocked extends Error {
	constructor() {
		super('The browser blocked the download tab.');
		this.name = 'DownloadBlocked';
	}
}
