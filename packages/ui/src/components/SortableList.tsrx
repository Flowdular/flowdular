import { useEffect, useRef, useState } from 'octane';
import type { OctaneNode } from 'octane';
import { Icon } from '../icons/Icon.tsrx';
import {
	clampIndex,
	droppedIndex,
	insertionIndex,
	moveItem,
	sameOrder,
} from './sortable.ts';

export interface SortableListItem {
	readonly id: string;
	readonly label: string;
}

export interface SortableAnnouncement {
	readonly kind: 'lifted' | 'moved' | 'dropped' | 'cancelled';
	/** The label of the item being moved. */
	readonly label: string;
	/** 1-based position the item holds now. */
	readonly position: number;
	readonly total: number;
}

export interface SortableListProps<Item extends SortableListItem> {
	/** Required: the prefix of the grip, instructions and live region ids. */
	readonly id: string;
	/** Accessible name of the list. */
	readonly label: string;
	/** The order on screen. The list never reorders `items` itself. */
	readonly items: readonly Item[];
	/** Called once per committed drop with the whole new order; never for an unchanged order or a cancel. */
	readonly onReorder: (ids: readonly string[]) => void;
	/** Accessible name of an item's grip, e.g. 'Move SearXNG'. */
	readonly handleLabel: (item: Item) => string;
	/** How to reorder from the keyboard, read as every grip's description. */
	readonly instructions: string;
	/** The polite announcement for each step, in the screen's words. */
	readonly announce: (event: SortableAnnouncement) => string;
	readonly renderItem: (item: Item, index: number) => OctaneNode;
	readonly disabled?: boolean | undefined;
}

interface Session {
	readonly mode: 'keyboard' | 'pointer';
	readonly id: string;
	readonly origin: readonly string[];
	/** The provisional order while the keyboard holds the item. */
	readonly order: readonly string[];
	/** Insertion index into `origin` while a pointer drags; null before it moves. */
	readonly insertion: number | null;
	readonly pointerId: number;
}

function pointerOf(event: PointerEvent): number {
	return typeof event.pointerId === 'number' ? event.pointerId : 0;
}

function orderOf(session: Session): readonly string[] {
	if (session.mode === 'keyboard') return session.order;
	if (session.insertion === null) return session.origin;
	const from = session.origin.indexOf(session.id);
	return moveItem(session.origin, from, droppedIndex(from, session.insertion));
}

/**
 * A reorderable list. Every item carries a grip button: from the keyboard,
 * Space or Enter picks the item up, the arrows move it, Space or Enter drops it
 * and Escape puts it back; with a pointer, the grip drags the item and a line
 * marks where it lands. Each step is announced in a polite live region, and
 * the screen receives one `onReorder` per committed change.
 */
export function SortableList<Item extends SortableListItem>(
	props: SortableListProps<Item>,
) @{
	const [session, setSession] = useState<Session | null>(null);
	const [message, setMessage] = useState('');
	const sessionRef = useRef<Session | null>(null);
	const listRef = useRef<HTMLOListElement | null>(null);
	/* The grip that must hold focus after the render a keyboard step causes. A
   keyed move can take the focused node out of the document for an instant,
   and the blur that causes is not the reader leaving the list. */
	const focusRef = useRef<string | null>(null);
	const instructionsId = props.id + '-instructions';
	const handleId = (id: string) => props.id + '-handle-' + id;
	const ids = props.items.map((item) => item.id);

	const begin = (next: Session | null) => {
		sessionRef.current = next;
		setSession(next);
	};

	const say = (
		kind: SortableAnnouncement['kind'],
		id: string,
		order: readonly string[],
	) => {
		const item = props.items.find((candidate) => candidate.id === id);
		setMessage(
			props.announce({
				kind,
				label: item?.label ?? id,
				position: order.indexOf(id) + 1,
				total: order.length,
			}),
		);
	};

	const drop = () => {
		const current = sessionRef.current;
		if (current === null) return;
		const next = orderOf(current);
		begin(null);
		say('dropped', current.id, next);
		if (!sameOrder(next, current.origin)) props.onReorder(next);
	};

	const cancel = () => {
		const current = sessionRef.current;
		if (current === null) return;
		begin(null);
		say('cancelled', current.id, current.origin);
	};

	useEffect(() => {
		const id = focusRef.current;
		if (id === null) return;
		focusRef.current = null;
		const handle = document.getElementById(handleId(id));
		if (handle !== null && document.activeElement !== handle) handle.focus();
	}, [session]);

	/* Escape during a drag reaches whatever holds focus, so it is caught on the
   way down, before a drawer around the list reads it as its own. */
	useEffect(() => {
		if (session?.mode !== 'pointer') return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			event.stopPropagation();
			cancel();
		};
		window.addEventListener('keydown', onKeyDown, true);
		return () => window.removeEventListener('keydown', onKeyDown, true);
	}, [session?.mode]);

	const onKeyDown = (event: KeyboardEvent, item: Item) => {
		if (props.disabled) return;
		const key = event.key;
		const current = sessionRef.current;
		if (current === null) {
			if (key !== ' ' && key !== 'Enter') return;
			event.preventDefault();
			focusRef.current = item.id;
			begin({
				mode: 'keyboard',
				id: item.id,
				origin: ids,
				order: ids,
				insertion: null,
				pointerId: -1,
			});
			say('lifted', item.id, ids);
			return;
		}
		if (current.mode !== 'keyboard' || current.id !== item.id) return;
		if (key === 'ArrowUp' || key === 'ArrowDown') {
			event.preventDefault();
			const from = current.order.indexOf(current.id);
			const to = clampIndex(
				from + (key === 'ArrowUp' ? -1 : 1),
				current.order.length,
			);
			if (to === from) return;
			const order = moveItem(current.order, from, to);
			focusRef.current = current.id;
			begin({ ...current, order });
			say('moved', current.id, order);
		} else if (key === ' ' || key === 'Enter') {
			event.preventDefault();
			focusRef.current = current.id;
			drop();
		} else if (key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			focusRef.current = current.id;
			cancel();
		}
	};

	const onBlur = (item: Item) => {
		if (focusRef.current !== null) return;
		const current = sessionRef.current;
		if (current?.mode === 'keyboard' && current.id === item.id) cancel();
	};

	const onPointerDown = (event: PointerEvent, item: Item) => {
		if (props.disabled || sessionRef.current !== null || event.button !== 0) {
			return;
		}
		const pointerId = pointerOf(event);
		const handle = event.currentTarget as HTMLElement;
		try {
			handle.setPointerCapture?.(pointerId);
		} catch {
			/* A pointer the browser no longer tracks still drags within the grip. */
		}
		begin({
			mode: 'pointer',
			id: item.id,
			origin: ids,
			order: ids,
			insertion: null,
			pointerId,
		});
		say('lifted', item.id, ids);
	};

	const onPointerMove = (event: PointerEvent) => {
		const current = sessionRef.current;
		const list = listRef.current;
		if (
			current?.mode !== 'pointer' || pointerOf(event) !== current.pointerId ||
				list === null
		) {
			return;
		}
		event.preventDefault();
		const midpoints = Array.from(list.children).map((row) => {
			const rect = row.getBoundingClientRect();
			return rect.top + rect.height / 2;
		});
		const insertion = insertionIndex(midpoints, event.clientY);
		if (insertion === current.insertion) return;
		const next = { ...current, insertion };
		const before = orderOf(current).indexOf(current.id);
		const order = orderOf(next);
		begin(next);
		if (order.indexOf(current.id) !== before) say('moved', current.id, order);
	};

	const release = (event: PointerEvent): boolean => {
		const current = sessionRef.current;
		if (current?.mode !== 'pointer' || pointerOf(event) !== current.pointerId) {
			return false;
		}
		const handle = event.currentTarget as HTMLElement;
		try {
			handle.releasePointerCapture?.(current.pointerId);
		} catch {
			/* Already released by the browser. */
		}
		return true;
	};

	const byId = new Map(props.items.map((item) => [item.id, item]));
	const shown =
		session?.mode === 'keyboard'
			? session.order.flatMap((id) => {
					const item = byId.get(id);
					return item === undefined ? [] : [item];
				})
			: props.items;
	const dragFrom =
		session?.mode === 'pointer' ? session.origin.indexOf(session.id) : -1;
	const indicator =
		session?.mode === 'pointer' && session.insertion !== null &&
		droppedIndex(dragFrom, session.insertion) !== dragFrom
			? session.insertion
			: null;

	const rows = shown.map((item, index) => ({ item, index }));

	<>
		<ol class="ui-sortable" aria-label={props.label} ref={listRef}>
			@for (const row of rows; key row.item.id) {
				<li
					class={[
						'ui-sortable__item',
						session?.id === row.item.id &&
							(session.mode === 'keyboard'
								? 'ui-sortable__item--lifted'
								: 'ui-sortable__item--dragging'),
						indicator === row.index && 'ui-sortable__item--drop-before',
						indicator === shown.length && row.index === shown.length - 1 &&
							'ui-sortable__item--drop-after',
					]}
				>
					<button
						class="ui-sortable__handle"
						type="button"
						id={handleId(row.item.id)}
						aria-label={props.handleLabel(row.item)}
						aria-describedby={instructionsId}
						aria-pressed={session?.id === row.item.id}
						disabled={props.disabled ?? false}
						onKeyDown={(event: KeyboardEvent) => onKeyDown(event, row.item)}
						onBlur={() => onBlur(row.item)}
						onPointerDown={(event: PointerEvent) => onPointerDown(
							event,
							row.item,
						)}
						onPointerMove={onPointerMove}
						onPointerUp={(event: PointerEvent) => {
							if (release(event)) drop();
						}}
						onPointerCancel={(event: PointerEvent) => {
							if (release(event)) cancel();
						}}
					>
						<Icon name="chevrons-up-down" size={16} />
					</button>
					<div class="ui-sortable__body">{props.renderItem(
						row.item,
						row.index,
					)}</div>
				</li>
			}
		</ol>
		<span
			class="ui-visually-hidden"
			id={instructionsId}
		>{props.instructions}</span>
		<span
			class="ui-visually-hidden"
			role="status"
			aria-live="polite"
		>{message}</span>
	</>
}
