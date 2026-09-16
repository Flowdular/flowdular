import { DOCUMENT_TEXT_PAGE_BREAK } from '../../domain/text.ts';

export interface PageBounds {
	readonly pages: number;
	readonly textBytes: number;
	readonly flowPageCharacters: number;
}

export interface WrittenPages {
	readonly pages: readonly string[];
	readonly truncated: boolean;
}

const NUL = String.fromCharCode(0);

function utf8Prefix(text: string, bytes: number): string {
	let used = 0;
	let end = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character, 'utf8');
		if (used + size > bytes) break;
		used += size;
		end += character.length;
	}
	return text.slice(0, end);
}

/* A page keeps the form feed as the separator the stored text is split on, and
   PostgreSQL text refuses NUL, so neither survives inside a page. */
function normalized(text: string): string {
	return text
		.replace(/\r\n?/g, '\n')
		.replace(/[\f\v]/g, '\n')
		.replaceAll(NUL, '');
}

/**
 * Collects the pages a reader produces under the page and text bounds. In flow
 * mode a page longer than the flow page is cut at its last line break inside
 * the bound, or at the bound when it holds none. `full` tells a reader to stop:
 * whatever it would still write is past a bound, and `truncated` records that.
 */
export class PageWriter {
	readonly #bounds: PageBounds;
	readonly #flow: boolean;
	readonly #pages: string[] = [];
	#current: string | null = null;
	#bytes = 0;
	#truncated = false;
	#full = false;

	constructor(bounds: PageBounds, flow: boolean) {
		this.#bounds = bounds;
		this.#flow = flow;
	}

	get full(): boolean {
		return this.#full;
	}

	get hasText(): boolean {
		return (
			this.#pages.some((page) => page.trim() !== '') ||
			(this.#current ?? '').trim() !== ''
		);
	}

	startPage(): void {
		if (this.#full) return;
		if (this.#current !== null) this.#close(this.#current);
		if (this.#pages.length >= this.#bounds.pages) {
			this.#stop();
			return;
		}
		this.#current = '';
	}

	write(value: string): void {
		if (this.#full || value === '') return;
		if (this.#current === null) {
			this.startPage();
			if (this.#full) return;
		}
		let text = normalized(value);
		const size = Buffer.byteLength(text, 'utf8');
		if (this.#bytes + size > this.#bounds.textBytes) {
			text = utf8Prefix(text, this.#bounds.textBytes - this.#bytes);
			this.#bytes = this.#bounds.textBytes;
			this.#current += text;
			this.#split();
			this.#stop();
			return;
		}
		this.#bytes += size;
		this.#current += text;
		this.#split();
	}

	/** Stops reading as if a bound was reached. */
	cut(): void {
		this.#stop();
	}

	finish(): WrittenPages {
		if (this.#current !== null) this.#close(this.#current);
		this.#current = null;
		return { pages: this.#pages, truncated: this.#truncated };
	}

	#split(): void {
		if (!this.#flow || this.#current === null) return;
		const limit = this.#bounds.flowPageCharacters;
		while (this.#current !== null && this.#current.length > limit) {
			const text: string = this.#current;
			const lineEnd = text.lastIndexOf('\n', limit);
			let head: string;
			let rest: string;
			if (lineEnd > 0) {
				head = text.slice(0, lineEnd);
				rest = text.slice(lineEnd + 1);
			} else {
				const code = text.charCodeAt(limit - 1);
				const cut = code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
				head = text.slice(0, cut);
				rest = text.slice(cut);
			}
			this.#close(head);
			if (this.#pages.length >= this.#bounds.pages) {
				this.#current = null;
				if (rest.trim() !== '') this.#stop();
				return;
			}
			this.#current = rest;
		}
	}

	#close(page: string): void {
		this.#pages.push(page.replace(/\s+$/, ''));
		this.#current = null;
	}

	#stop(): void {
		if (this.#current !== null) this.#close(this.#current);
		this.#truncated = true;
		this.#full = true;
	}
}

export function joinPages(pages: readonly string[]): string {
	return pages.join(DOCUMENT_TEXT_PAGE_BREAK);
}
