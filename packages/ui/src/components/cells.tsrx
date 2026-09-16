import { useContext, useEffect, useRef, useState } from 'octane';
import type { OctaneNode } from 'octane';
import { Icon } from '../icons/Icon.tsrx';
import {
	cellNumber,
	cellTime,
	shortCode,
	type CellTimeKind,
} from './cell-format.ts';
import { CellControlsContext, TableLocaleContext } from './table-locale.ts';
import { Tag, type TagTone } from './Tag.tsrx';

function textOf(node: OctaneNode): string | undefined {
	return typeof node === 'string' || typeof node === 'number'
		? String(node)
		: undefined;
}

function present(node: OctaneNode): boolean {
	return node !== undefined && node !== null && node !== false && node !== '';
}

export interface CellTextProps {
	readonly value: string;
	readonly strong?: boolean | undefined;
	readonly mono?: boolean | undefined;
	/** Prose (a description, a message, a list): wraps at spaces, two lines at most. */
	readonly wrap?: boolean | undefined;
	/** The hover reading when it says more than the value, e.g. the whole list a summary stands for. */
	readonly title?: string | undefined;
}

/** One line of text that ends in an ellipsis, with the whole value as its title. */
export function CellText(props: CellTextProps) @{
	<span
		class={[
			'ui-cell-text',
			props.strong && 'ui-cell-text--strong',
			props.mono && 'ui-cell-text--mono',
			props.wrap && 'ui-cell-text--wrap',
		]}
		title={props.title ?? props.value}
	>{props.value}</span>
}

export interface CellStackProps {
	readonly primary: OctaneNode;
	readonly secondary?: OctaneNode;
	readonly primaryMono?: boolean | undefined;
	readonly secondaryMono?: boolean | undefined;
}

/** A primary line over a secondary one (a name over its id), each one line with an ellipsis. */
export function CellStack(props: CellStackProps) @{
	<span class="ui-cell-stack">
		<span
			class={[
				'ui-cell-stack__primary',
				props.primaryMono && 'ui-cell-stack__line--mono',
			]}
			title={textOf(props.primary)}
		>{props.primary}</span>
		@if (present(props.secondary)) {
			<span
				class={[
					'ui-cell-stack__secondary',
					props.secondaryMono && 'ui-cell-stack__line--mono',
				]}
				title={textOf(props.secondary)}
			>{props.secondary}</span>
		}
	</span>
}

export interface CellTimeProps {
	/** An ISO string, a `YYYY-MM-DD` day, epoch milliseconds or a Date. */
	readonly value: string | number | Date;
	/** 'date' leaves the time of day out. */
	readonly kind?: CellTimeKind | undefined;
	/** IANA zone the value reads in, e.g. a schedule's own zone; the title then names it. */
	readonly timeZone?: string | undefined;
}

/** A compact local date and time that never wraps; the full timestamp is its title. */
export function CellTime(props: CellTimeProps) @{
	const table = useContext(TableLocaleContext);
	const reading = cellTime(
		props.value,
		props.kind ?? 'datetime',
		table.locale,
		undefined,
		props.timeZone,
	);
	@if (reading) {
		<time
			class="ui-cell-time"
			datetime={reading.datetime}
			title={reading.full}
		>{reading.text}</time>
	} @else {
		<span class="ui-cell-muted">{String(props.value)}</span>
	}
}

export interface CellCodeProps {
	readonly value: string;
	/** Longest value shown whole; a longer one keeps its head and tail. Default 16. */
	readonly max?: number | undefined;
	/** The copy button beside the value. Default true. */
	readonly copy?: boolean | undefined;
}

const COPIED_MS = 1500;

/** An identifier in monospace, shortened in the middle, with a copy button on row hover and focus. */
export function CellCode(props: CellCodeProps) @{
	const table = useContext(TableLocaleContext);
	const controls = useContext(CellControlsContext);
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			if (timer.current !== null) clearTimeout(timer.current);
		};
	}, []);
	const shown = shortCode(props.value, props.max ?? 16);
	const label = copied ? table.copied : table.copy;
	const copy = (event: MouseEvent) => {
		event.stopPropagation();
		const clipboard = globalThis.navigator?.clipboard;
		if (clipboard === undefined) return;
		clipboard.writeText(props.value).then(
			() => {
				if (!alive.current) return;
				setCopied(true);
				if (timer.current !== null) clearTimeout(timer.current);
				timer.current = setTimeout(() => {
					timer.current = null;
					if (alive.current) setCopied(false);
				}, COPIED_MS);
			},
			() => {},
		);
	};

	<span class="ui-cell-code">
		<code class="ui-cell-code__value" title={props.value}>
			@if (shown === props.value) {
				<>
					{props.value}
				</>
			} @else {
				<>
					<span aria-hidden="true">{shown}</span>
					<span class="ui-visually-hidden">{props.value}</span>
				</>
			}
		</code>
		@if (props.copy !== false && controls) {
			<button
				class={['ui-cell-code__copy', copied && 'ui-cell-code__copy--done']}
				type="button"
				aria-label={label}
				title={label}
				onClick={copy}
			>
				<Icon name={copied ? 'check' : 'copy'} size={14} />
			</button>
		}
	</span>
}

export interface CellTagProps {
	readonly label: string;
	readonly tone?: TagTone | undefined;
	readonly dot?: boolean | undefined;
	readonly mono?: boolean | undefined;
}

/** A Tag whose label ends in an ellipsis instead of being cut, with the label as its title. */
export function CellTag(props: CellTagProps) @{
	<Tag
		tone={props.tone ?? 'neutral'}
		dot={props.dot ?? false}
		mono={props.mono ?? false}
	>
		<span class="ui-tag__label" title={props.label}>{props.label}</span>
	</Tag>
}

export interface CellNumberProps {
	readonly value: number | bigint;
	readonly options?: Intl.NumberFormatOptions | undefined;
}

/** A number in the reader's locale with tabular figures; the column declares `numeric`. */
export function CellNumber(props: CellNumberProps) @{
	const table = useContext(TableLocaleContext);
	<span class="ui-cell-number">{cellNumber(
		props.value,
		table.locale,
		props.options,
	)}</span>
}

export interface CellMutedProps {
	readonly children?: OctaneNode;
}

/** The placeholder for a missing value: "None", "Never". */
export function CellMuted(props: CellMutedProps) @{
	<span class="ui-cell-muted">{props.children}</span>
}
