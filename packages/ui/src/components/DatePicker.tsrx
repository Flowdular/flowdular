import { useEffect, useMemo, useRef, useState } from 'octane';
import { Icon } from '../icons/Icon.tsrx';
import {
	addDays,
	addMonths,
	clampIsoDay,
	dayLabel,
	firstWeekday,
	isoDay,
	monthLabel,
	monthWeeks,
	startOfMonth,
	todayIso,
	weekdayIndex,
	weekdayLabels,
} from './calendar.ts';
import { dateInputType, formatDateValue } from './date-field.ts';
import type { DateFieldKind } from './date-field.ts';
import type { DateRange } from './DateRangeField.tsrx';
import { trapFocus } from './focus-trap.ts';

export type DatePickerMode = 'single' | 'range';

/** One window the reader can take in a click. `datePresetRange` builds the standard four. */
export interface DatePickerPreset {
	readonly id: string;
	readonly label: string;
	readonly range: DateRange;
}

export interface DatePickerProps {
	/** Required: the control id in 'single' mode, the `-from` and `-to` prefix in 'range'. */
	readonly id: string;
	/** The field label in 'single' mode, the group label in 'range'. */
	readonly label: string;
	readonly mode?: DatePickerMode | undefined;
	/** Both ends of the selection. 'single' reads and writes `from`, and `to` follows it. */
	readonly value: DateRange;
	readonly onChange: (value: DateRange) => void;
	readonly kind?: DateFieldKind | undefined;
	/** BCP 47 tag for the month, weekday and day readings; screens pass `activeLocale()`. */
	readonly locale?: string | undefined;
	/** ISO bounds, of the same kind as the value. Days outside them are never selectable. */
	readonly min?: string | undefined;
	readonly max?: string | undefined;
	/** Windows offered above the calendar; omit for a picker without them. */
	readonly presets?: readonly DatePickerPreset[] | undefined;
	readonly presetsLabel?: string | undefined;
	/** Labels of the two inputs in 'range' mode. */
	readonly fromLabel?: string | undefined;
	readonly toLabel?: string | undefined;
	/** Accessible name of the button that opens the calendar. */
	readonly openLabel: string;
	readonly previousMonthLabel: string;
	readonly nextMonthLabel: string;
	/** Submitted field name; defaults to the input id. */
	readonly name?: string | undefined;
	readonly required?: boolean | undefined;
	readonly disabled?: boolean | undefined;
	/** Marks the control invalid without occupying the message line. */
	readonly invalid?: boolean | undefined;
	readonly help?: string | undefined;
	readonly error?: string | undefined;
	readonly autoFocus?: boolean | undefined;
}

/* A datetime keeps the time it already had: the calendar answers about days,
   and a picked day must not silently move an appointment to midnight. */
function withTime(
	day: string,
	previous: string,
	kind: DateFieldKind | undefined,
): string {
	if (day === '' || kind !== 'datetime') return day;
	return day + 'T' + (previous.length >= 16 ? previous.slice(11, 16) : '00:00');
}

/* Values of one kind order chronologically as text, so a bound costs a string
   comparison. A day inside the bounds whose time is not (an expiry of "later
   today") lands on the bound rather than outside it. */
function clampValue(
	value: string,
	min: string | undefined,
	max: string | undefined,
): string {
	if (value === '') return value;
	if (min !== undefined && min !== '' && value < min) return min;
	if (max !== undefined && max !== '' && value > max) return max;
	return value;
}

function sameRange(left: DateRange, right: DateRange): boolean {
	return isoDay(left.from) === isoDay(right.from) &&
		isoDay(left.to) === isoDay(right.to);
}

/**
 * The calendar picker: one popover holding the presets and the month grid, over
 * the native inputs that carry the ISO value the platform stores and the form
 * submits. A range is picked in that one calendar, first end then second, and
 * the two are ordered on the way out, so the picker can never produce a
 * reversed range.
 *
 * Keyboard: the trigger opens the popover on the day the value names, arrows
 * move by day and week, PageUp and PageDown by month, Home and End to the ends
 * of the week, Enter or Space selects, and Escape closes and returns focus to
 * the trigger without reaching a dialog behind it.
 */
export function DatePicker(props: DatePickerProps) @{
	const range = props.mode === 'range';
	const kind = props.kind;
	const locale = props.locale;
	const bounds = { min: props.min, max: props.max };
	const [open, setOpen] = useState(false);
	const [month, setMonth] = useState('');
	const [cursor, setCursor] = useState('');
	/** The first end of a range while the second is still being picked. */
	const [anchor, setAnchor] = useState('');
	/** Viewport coordinates of the open popover; null until it is measured. */
	const [placement, setPlacement] = useState<
		| {
				readonly top: number;
				readonly left: number;
		  }
		| null
	>(null);
	/** The placement last written, so a scroll that moves nothing costs nothing. */
	const placedRef = useRef<{ top: number; left: number } | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const popoverRef = useRef<HTMLDivElement | null>(null);
	const rowRef = useRef<HTMLDivElement | null>(null);

	const weekStart = useMemo(() => firstWeekday(locale), [locale]);
	const weekdays = useMemo(
		() => weekdayLabels(weekStart, locale).map(
			(label, index) => ({ key: index, label }),
		),
		[weekStart, locale],
	);
	const weeks = useMemo(() => monthWeeks(month, weekStart, bounds), [
		month,
		weekStart,
		props.min,
		props.max,
	]);

	const selectedFrom =
		anchor !== '' ? anchor : isoDay(props.value.from);
	const selectedTo =
		anchor !== '' ? '' : isoDay(range ? props.value.to : props.value.from);
	const today = todayIso();

	const close = (restoreFocus: boolean) => {
		setOpen(false);
		setAnchor('');
		if (restoreFocus) triggerRef.current?.focus();
	};

	const openCalendar = () => {
		const start = clampIsoDay(isoDay(props.value.from) || today, bounds);
		setMonth(startOfMonth(start));
		setCursor(start);
		setAnchor('');
		placedRef.current = null;
		setPlacement(null);
		setOpen(true);
	};

	/* A drawer body scrolls, and an `overflow` box clips an absolutely placed
   child even when it is not scrolling. The popover is placed against the
   viewport instead, measured once it is on screen and again whenever anything
   under it scrolls or the window resizes. */
	useEffect(() => {
		if (!open) return;
		const place = () => {
			const row = rowRef.current;
			if (row === null) return;
			const anchorRect = row.getBoundingClientRect();
			const popover = popoverRef.current;
			const height = popover?.offsetHeight ?? 0;
			const width = popover?.offsetWidth ?? 0;
			const below = anchorRect.bottom + 6;
			const next = {
				top: below + height <= window.innerHeight - 8
					? below
					: Math.max(8, anchorRect.top - 6 - height),
				left: Math.max(
					8,
					Math.min(anchorRect.left, window.innerWidth - width - 8),
				),
			};
			/* Scrolling fires per frame, and most frames leave the popover exactly
		   where it was: measuring is cheap, re-rendering the month is not. */
			const last = placedRef.current;
			if (
				last !== null && last.top === next.top && last.left === next.left
			) return;
			placedRef.current = next;
			setPlacement(next);
		};
		place();
		window.addEventListener('scroll', place, true);
		window.addEventListener('resize', place);
		return () => {
			window.removeEventListener('scroll', place, true);
			window.removeEventListener('resize', place);
		};
	}, [open]);

	/* The day under the reader is the only stop in the grid's tab order, so
   moving the cursor has to carry focus with it. Focusing must not scroll: the
   popover is placed against the viewport it would move. */
	useEffect(() => {
		if (!open) return;
		popoverRef.current?.querySelector<HTMLElement>(
			`[data-day="${cursor}"]`,
		)?.focus({ preventScroll: true });
	}, [open, cursor]);

	/* Tab must not walk the workspace behind an open calendar. The trap is
   installed after the cursor has taken focus, so it keeps the day the reader is
   on and leaves restoring the trigger to `close`. */
	useEffect(() => {
		if (!open) return;
		const popover = popoverRef.current;
		return popover === null ? undefined : trapFocus(popover);
	}, [open]);

	/* A day outside the bounds is rendered but never focusable, so a cursor that
   landed on one would take the grid's only tab stop with it and leave the
   reader's focus behind. The move stops at the bound instead. */
	const moveCursor = (next: string) => {
		const target = clampIsoDay(next, bounds);
		if (target === '' || target === cursor) return;
		setCursor(target);
		if (target.slice(0, 7) !== month.slice(0, 7)) setMonth(
			startOfMonth(target),
		);
	};

	const emit = (from: string, to: string) => {
		props.onChange({
			from: clampValue(
				withTime(from, props.value.from, kind),
				props.min,
				props.max,
			),
			to: clampValue(
				withTime(to, props.value.to || props.value.from, kind),
				props.min,
				props.max,
			),
		});
	};

	const selectDay = (day: string) => {
		if (!range) {
			emit(day, day);
			close(true);
			return;
		}
		if (anchor === '') {
			setAnchor(day);
			return;
		}
		const ordered =
			day < anchor ? [day, anchor] : [anchor, day];
		setAnchor('');
		emit(ordered[0] ?? '', ordered[1] ?? '');
		close(true);
	};

	const pickPreset = (preset: DatePickerPreset) => {
		setAnchor('');
		props.onChange(preset.range);
		close(true);
	};

	const onGridKeyDown = (event: KeyboardEvent) => {
		const key = event.key;
		if (key === 'ArrowLeft') moveCursor(addDays(cursor, -1));
		else if (key === 'ArrowRight') moveCursor(addDays(cursor, 1));
		else if (key === 'ArrowUp') moveCursor(addDays(cursor, -7));
		else if (key === 'ArrowDown') moveCursor(addDays(cursor, 7));
		else if (key === 'Home') moveCursor(
			addDays(cursor, -weekdayIndex(cursor, weekStart)),
		);
		else if (key === 'End') moveCursor(
			addDays(cursor, 6 - weekdayIndex(cursor, weekStart)),
		);
		else if (key === 'PageUp') moveCursor(addMonths(cursor, -1));
		else if (key === 'PageDown') moveCursor(addMonths(cursor, 1));
		else return;
		event.preventDefault();
	};

	/* Escape closes the calendar and stops there: a picker inside a Drawer must
   not dismiss the drawer with the same keystroke. */
	const onPopoverKeyDown = (event: KeyboardEvent) => {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		close(true);
	};

	const changeFrom = (next: string) => {
		props.onChange(
			range ? { from: next, to: props.value.to } : { from: next, to: next },
		);
	};

	const message = props.error ?? '';
	const invalid = props.invalid === true || message !== '';
	const describedBy =
		message
			? props.id + '-error'
			: props.help
				? props.id + '-help'
				: undefined;
	const fromId = range ? props.id + '-from' : props.id;
	const heading = monthLabel(month, locale);
	const presets = props.presets ?? [];
	const fromReading = formatDateValue(props.value.from, kind, locale);
	const toReading = formatDateValue(props.value.to, kind, locale);

	<div
		class="ui-field ui-datepicker"
		role={range ? 'group' : undefined}
		aria-labelledby={range ? props.id + '-legend' : undefined}
	>
		@if (range) {
			<span class="ui-label" id={props.id + '-legend'}>
				{props.label}
				@if (props.required) {
					<em aria-hidden="true">{' *'}</em>
				}
			</span>
		} @else {
			<label class="ui-label" for={fromId}>
				{props.label}
				@if (props.required) {
					<em aria-hidden="true">{' *'}</em>
				}
			</label>
		}
		<div class="ui-datepicker__row" ref={rowRef}>
			<div class="ui-datefield">
				<input
					class={['ui-input', invalid && 'ui-input--error']}
					type={dateInputType(kind)}
					id={fromId}
					name={props.name ?? fromId}
					value={props.value.from}
					min={props.min ?? undefined}
					max={range && props.value.to || props.max || undefined}
					required={props.required ?? false}
					disabled={props.disabled ?? false}
					autoFocus={props.autoFocus ?? false}
					aria-invalid={invalid}
					aria-label={range ? props.fromLabel ?? '' : undefined}
					aria-describedby={describedBy}
					onInput={(event) => changeFrom(event.currentTarget.value)}
				/>
				@if (fromReading) {
					<span class="ui-datefield__reading">
						<Icon name="calendar" size={14} />
						{fromReading}
					</span>
				}
			</div>
			@if (range) {
				<div class="ui-datefield">
					<input
						class={['ui-input', invalid && 'ui-input--error']}
						type={dateInputType(kind)}
						id={props.id + '-to'}
						name={props.id + '-to'}
						value={props.value.to}
						min={props.value.from || props.min || undefined}
						max={props.max ?? undefined}
						required={props.required ?? false}
						disabled={props.disabled ?? false}
						aria-invalid={invalid}
						aria-label={props.toLabel ?? ''}
						aria-describedby={describedBy}
						onInput={(event) => props.onChange({
							from: props.value.from,
							to: event.currentTarget.value,
						})}
					/>
					@if (toReading) {
						<span class="ui-datefield__reading">
							<Icon name="calendar" size={14} />
							{toReading}
						</span>
					}
				</div>
			}
			<button
				class="ui-datepicker__trigger"
				type="button"
				aria-label={props.openLabel}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-controls={props.id + '-calendar'}
				disabled={props.disabled ?? false}
				ref={triggerRef}
				onClick={() => (open ? close(false) : openCalendar())}
			>
				<Icon name="calendar" size={16} />
			</button>
		</div>
		@if (open) {
			<>
				<div class="ui-datepicker__scrim" onClick={() => close(true)}></div>
				<div
					class="ui-datepicker__popover"
					id={props.id + '-calendar'}
					role="dialog"
					aria-label={props.label}
					tabindex={-1}
					style={placement === null
						? 'visibility: hidden;'
						: `top: ${placement.top}px; left: ${placement.left}px;`}
					ref={popoverRef}
					onKeyDown={onPopoverKeyDown}
				>
					@if (presets.length > 0) {
						<div
							class="ui-datepicker__presets"
							role="group"
							aria-label={props.presetsLabel ?? props.label}
						>
							@for (const preset of presets; key preset.id) {
								<button
									class="ui-datepicker__preset"
									type="button"
									aria-pressed={sameRange(preset.range, props.value)}
									onClick={() => pickPreset(preset)}
								>{preset.label}</button>
							}
						</div>
					}
					<div class="ui-datepicker__calendar">
						<div class="ui-datepicker__head">
							<button
								class="ui-datepicker__step"
								type="button"
								aria-label={props.previousMonthLabel}
								onClick={() => setMonth(addMonths(month, -1))}
							>
								<Icon name="chevron-left" size={16} />
							</button>
							<b class="ui-datepicker__month" aria-live="polite">{heading}</b>
							<button
								class="ui-datepicker__step"
								type="button"
								aria-label={props.nextMonthLabel}
								onClick={() => setMonth(addMonths(month, 1))}
							>
								<Icon name="chevron-right" size={16} />
							</button>
						</div>
						<table
							class="ui-datepicker__grid"
							role="grid"
							aria-label={heading}
							onKeyDown={onGridKeyDown}
						>
							<thead>
								<tr>
									@for (const weekday of weekdays; key weekday.key) {
										<th scope="col">{weekday.label}</th>
									}
								</tr>
							</thead>
							<tbody>
								@for (const week of weeks; key week.key) {
									<tr>
										@for (const day of week.days; key day.iso) {
											<td
												role="gridcell"
												aria-selected={day.iso === selectedFrom ||
													day.iso === selectedTo}
											>
												<button
													class={[
														'ui-datepicker__day',
														!day.inMonth && 'ui-datepicker__day--outside',
														(day.iso === selectedFrom ||
															day.iso === selectedTo) &&
															'ui-datepicker__day--on',
														selectedTo !== '' && day.iso > selectedFrom &&
															day.iso < selectedTo &&
															'ui-datepicker__day--between',
													]}
													type="button"
													data-day={day.iso}
													tabindex={day.iso === cursor ? 0 : -1}
													disabled={day.disabled}
													aria-label={dayLabel(day.iso, locale)}
													aria-current={day.iso === today ? 'date' : undefined}
													onClick={() => selectDay(day.iso)}
												>{String(day.dayOfMonth)}</button>
											</td>
										}
									</tr>
								}
							</tbody>
						</table>
					</div>
				</div>
			</>
		}
		@if (message) {
			<span
				class="ui-help ui-help--error"
				id={props.id + '-error'}
				role="alert"
			>{message}</span>
		} @else if (props.help) {
			<span class="ui-help" id={props.id + '-help'}>{props.help}</span>
		}
	</div>
}
