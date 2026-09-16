import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	CellCode,
	CellMuted,
	CellNumber,
	CellStack,
	CellTag,
	CellText,
	CellTime,
} from '../src/components/cells.tsrx';
import {
	CellControlsContext,
	DEFAULT_TABLE_LOCALE,
	TableLocaleContext,
} from '../src/components/table-locale.ts';
import { mount, run, text } from './dom.ts';

afterEach(() => {
	vi.useRealTimers();
});

describe('CellText', () => {
	it('keeps the whole value as the title of its one line', async () => {
		const mounted = await mount(<CellText value="admin@example.com" strong />);
		const cell = mounted.container.querySelector(
			'.ui-cell-text',
		) as HTMLElement;
		expect(cell.getAttribute('title')).toBe('admin@example.com');
		expect(cell.classList.contains('ui-cell-text--strong')).toBe(true);
		expect(cell.classList.contains('ui-cell-text--wrap')).toBe(false);
		mounted.unmount();
	});

	it('opts prose into wrapping', async () => {
		const mounted = await mount(
			<CellText value="role: owner · scopes: 12" wrap />,
		);
		expect(
			mounted.container.querySelector('.ui-cell-text--wrap'),
		).not.toBeNull();
		mounted.unmount();
	});
});

describe('CellStack', () => {
	it(
		'titles each text line and leaves out an empty secondary line',
		async () => {
			const mounted = await mount(
				<CellStack
					primary="Access review"
					secondary="access.core"
					secondaryMono
				/>,
			);
			const primary = mounted.container.querySelector(
				'.ui-cell-stack__primary',
			) as HTMLElement;
			const secondary = mounted.container.querySelector(
				'.ui-cell-stack__secondary',
			) as HTMLElement;
			expect(primary.getAttribute('title')).toBe('Access review');
			expect(secondary.getAttribute('title')).toBe('access.core');
			expect(secondary.classList.contains('ui-cell-stack__line--mono')).toBe(
				true,
			);
			await mounted.render(<CellStack primary="Access review" secondary="" />);
			expect(
				mounted.container.querySelector('.ui-cell-stack__secondary'),
			).toBeNull();
			mounted.unmount();
		},
	);

	it('takes a node as a line without inventing a title', async () => {
		const mounted = await mount(
			<CellStack primary={<CellTag label="Active" tone="success" dot />} />,
		);
		expect(
			mounted.container.querySelector('.ui-cell-stack__primary')?.getAttribute(
				'title',
			),
		).toBeNull();
		expect(text(mounted.container)).toBe('Active');
		mounted.unmount();
	});
});

describe('CellTime', () => {
	it(
		'renders a time element with the full timestamp as its title',
		async () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(new Date(2026, 8, 16, 12, 0, 0));
			const value = new Date(2026, 8, 16, 19, 39, 5);
			const mounted = await mount(
				<TableLocaleContext.Provider
					value={{ ...DEFAULT_TABLE_LOCALE, locale: 'pl' }}
				>
					<CellTime value={value.getTime()} />
				</TableLocaleContext.Provider>,
			);
			const time = mounted.container.querySelector('time') as HTMLElement;
			expect(time.getAttribute('datetime')).toBe(value.toISOString());
			expect(text(time)).toBe('16 wrz, 19:39');
			expect(time.getAttribute('title')).toContain('19:39:05');
			mounted.unmount();
		},
	);

	it('shows a value no date can hold as it came', async () => {
		const mounted = await mount(<CellTime value="soon" />);
		expect(mounted.container.querySelector('time')).toBeNull();
		expect(text(mounted.container.querySelector('.ui-cell-muted'))).toBe(
			'soon',
		);
		mounted.unmount();
	});
});

describe('CellCode', () => {
	const ID = '4783b5b2-1c5e-4bd8-9a55-7f0d2c3a40d8';

	it(
		'shortens a long id in the middle and keeps the whole id readable',
		async () => {
			const mounted = await mount(<CellCode value={ID} />);
			const code = mounted.container.querySelector('code') as HTMLElement;
			expect(code.getAttribute('title')).toBe(ID);
			expect(text(code.querySelector('[aria-hidden="true"]'))).toBe(
				'4783b5b2…40d8',
			);
			expect(text(code.querySelector('.ui-visually-hidden'))).toBe(ID);
			mounted.unmount();
		},
	);

	it('copies the whole id and says so', async () => {
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText },
			configurable: true,
		});
		const onRow = vi.fn();
		const mounted = await mount(
			<TableLocaleContext.Provider
				value={{
					...DEFAULT_TABLE_LOCALE,
					copy: 'Kopiuj',
					copied: 'Skopiowano',
				}}
			>
				<div onClick={onRow}>
					<CellCode value={ID} />
				</div>
			</TableLocaleContext.Provider>,
		);
		const button = mounted.container.querySelector(
			'.ui-cell-code__copy',
		) as HTMLButtonElement;
		expect(button.getAttribute('aria-label')).toBe('Kopiuj');
		await run(() => button.click());
		await run(() => {});
		expect(writeText).toHaveBeenCalledWith(ID);
		expect(onRow).not.toHaveBeenCalled();
		expect(
			mounted.container.querySelector('.ui-cell-code__copy')?.getAttribute(
				'aria-label',
			),
		).toBe('Skopiowano');
		mounted.unmount();
	});

	it('leaves the copy button out where a control may not nest', async () => {
		const mounted = await mount(
			<CellControlsContext.Provider value={false}>
				<CellCode value={ID} />
			</CellControlsContext.Provider>,
		);
		expect(mounted.container.querySelector('button')).toBeNull();
		mounted.unmount();
	});
});

describe('CellTag, CellNumber and CellMuted', () => {
	it('titles a tag label so a cut label can still be read', async () => {
		const mounted = await mount(
			<CellTag label="auth.sign-in.succeeded" tone="info" mono />,
		);
		const tag = mounted.container.querySelector('.ui-tag') as HTMLElement;
		expect(tag.classList.contains('ui-tag--info')).toBe(true);
		expect(tag.classList.contains('ui-tag--mono')).toBe(true);
		expect(tag.querySelector('.ui-tag__label')?.getAttribute('title')).toBe(
			'auth.sign-in.succeeded',
		);
		mounted.unmount();
	});

	it('formats a number in the locale the table was given', async () => {
		const mounted = await mount(
			<TableLocaleContext.Provider
				value={{ ...DEFAULT_TABLE_LOCALE, locale: 'en' }}
			>
				<CellNumber value={12345} />
				<CellMuted>None</CellMuted>
			</TableLocaleContext.Provider>,
		);
		expect(text(mounted.container.querySelector('.ui-cell-number'))).toBe(
			'12,345',
		);
		expect(text(mounted.container.querySelector('.ui-cell-muted'))).toBe(
			'None',
		);
		mounted.unmount();
	});
});
