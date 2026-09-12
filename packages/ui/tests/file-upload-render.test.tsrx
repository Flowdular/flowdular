import { describe, expect, it, vi } from 'vitest';
import { FileUpload } from '../src/components/FileUpload.tsrx';
import type { FileRefusalReason } from '../src/components/file-upload.ts';
import { mount, run, text } from './dom.ts';

const ACCEPT = ['application/pdf', 'image/png'];

function file(name: string, type: string, size: number): File {
	const blob = new File(['x'], name, { type });
	Object.defineProperty(blob, 'size', { value: size, configurable: true });
	return blob;
}

const CONTRACT = file('contract.pdf', 'application/pdf', 2_000);
const HUGE = file('scan.pdf', 'application/pdf', 90_000);
const SHEET = file('rows.csv', 'text/csv', 100);

const REFUSALS: Record<FileRefusalReason, string> = {
	type: 'That kind of file is not accepted.',
	size: 'That file is over the 25 KB limit.',
};

function upload(
	value: File | null,
	onChange: (next: File | null) => void,
	extra: {
		readonly maxBytes?: number | null;
		readonly busy?: boolean;
		readonly error?: string;
		readonly autoFocus?: boolean;
	} = {},
) {
	return <FileUpload
		id="document-file"
		label="File"
		accept={ACCEPT}
		maxBytes={extra.maxBytes ?? null}
		value={value}
		busy={extra.busy ?? false}
		busyLabel="Uploading…"
		error={extra.error ?? ''}
		autoFocus={extra.autoFocus ?? false}
		hint="PDF or PNG, up to 25 KB."
		clearLabel="Remove"
		required
		refusal={(reason) => REFUSALS[reason]}
		chosen={(chosen) => `${chosen.name}, ${chosen.size} bytes`}
		onChange={onChange}
	/>;
}

function control(container: HTMLElement): HTMLInputElement {
	return container.querySelector('input[type="file"]') as HTMLInputElement;
}

/* A file input's list is read-only to a page, so the pick a reader makes is
   simulated by the list the browser would have put there. */
async function pick(input: HTMLInputElement, chosen: File | null) {
	Object.defineProperty(input, 'files', {
		value: chosen === null ? [] : [chosen],
		configurable: true,
	});
	await run(() => input.dispatchEvent(new Event('change', { bubbles: true })));
}

describe('FileUpload', () => {
	it('states what is accepted while nothing is chosen', async () => {
		const mounted = await mount(upload(null, () => {}));
		const input = control(mounted.container);
		expect(input.getAttribute('accept')).toBe('application/pdf,image/png');
		expect(input.required).toBe(true);
		expect(input.id).toBe('document-file');
		expect(input.name).toBe('document-file');
		expect(text(mounted.container.querySelector('#document-file-help'))).toBe(
			'PDF or PNG, up to 25 KB.',
		);
		expect(mounted.container.querySelector('.ui-fileupload__clear')).toBeNull();
		mounted.unmount();
	});

	it('reports an accepted file and reads it back', async () => {
		const onChange = vi.fn();
		const mounted = await mount(upload(null, onChange));
		await pick(control(mounted.container), CONTRACT);
		expect(onChange).toHaveBeenCalledWith(CONTRACT);

		await mounted.render(upload(CONTRACT, onChange));
		expect(text(mounted.container.querySelector('#document-file-help'))).toBe(
			'contract.pdf, 2000 bytes',
		);
		expect(
			mounted.container.querySelector('.ui-fileupload__clear'),
		).not.toBeNull();
		mounted.unmount();
	});

	it('refuses a file past the ceiling in the screen own words', async () => {
		const onChange = vi.fn();
		const mounted = await mount(upload(null, onChange, { maxBytes: 25_000 }));
		const input = control(mounted.container);
		await pick(input, HUGE);
		expect(onChange).toHaveBeenCalledWith(null);
		const message = mounted.container.querySelector('#document-file-error');
		expect(text(message)).toBe(REFUSALS.size);
		expect(message?.getAttribute('role')).toBe('alert');
		expect(input.getAttribute('aria-invalid')).toBe('true');
		expect(input.classList.contains('ui-input--error')).toBe(true);
		/* The native list is emptied too, or choosing the same file again would
	   raise no event and the reader would see nothing happen. */
		expect(input.value).toBe('');
		mounted.unmount();
	});

	it('refuses a file the accept list does not cover', async () => {
		const onChange = vi.fn();
		const mounted = await mount(upload(null, onChange));
		await pick(control(mounted.container), SHEET);
		expect(onChange).toHaveBeenCalledWith(null);
		expect(text(mounted.container.querySelector('#document-file-error'))).toBe(
			REFUSALS.type,
		);
		mounted.unmount();
	});

	/* The limits answer arrives after the drawer opened, so a file chosen
   against no ceiling has to be re-read against the one that lands. */
	it('refuses a chosen file when the limit arrives after it', async () => {
		const onChange = vi.fn();
		const mounted = await mount(upload(HUGE, onChange, { maxBytes: null }));
		expect(onChange).not.toHaveBeenCalled();

		await mounted.render(upload(HUGE, onChange, { maxBytes: 25_000 }));
		expect(onChange).toHaveBeenCalledWith(null);
		expect(text(mounted.container.querySelector('#document-file-error'))).toBe(
			REFUSALS.size,
		);
		mounted.unmount();
	});

	it('drops the chosen file when the reader removes it', async () => {
		const onChange = vi.fn();
		const mounted = await mount(upload(CONTRACT, onChange));
		await run(() => {
			mounted.container.querySelector<HTMLButtonElement>(
				'.ui-fileupload__clear',
			)?.click();
		});
		expect(onChange).toHaveBeenCalledWith(null);
		mounted.unmount();
	});

	it('goes inert while the upload runs', async () => {
		const mounted = await mount(upload(CONTRACT, () => {}, { busy: true }));
		expect(control(mounted.container).disabled).toBe(true);
		expect(text(mounted.container.querySelector('#document-file-help'))).toBe(
			'Uploading…',
		);
		expect(mounted.container.querySelector('.ui-fileupload__clear')).toBeNull();
		mounted.unmount();
	});

	it('shows a failure the screen owns in place of the reading', async () => {
		const mounted = await mount(
			upload(CONTRACT, () => {}, { error: 'The upload was refused.' }),
		);
		expect(text(mounted.container.querySelector('#document-file-error'))).toBe(
			'The upload was refused.',
		);
		expect(mounted.container.querySelector('#document-file-help')).toBeNull();
		mounted.unmount();
	});

	it('takes focus on mount only when the screen asked for it', async () => {
		const plain = await mount(upload(null, () => {}));
		expect(document.activeElement?.id).not.toBe('document-file');
		plain.unmount();

		const focused = await mount(upload(null, () => {}, { autoFocus: true }));
		expect(document.activeElement?.id).toBe('document-file');
		focused.unmount();
	});
});
