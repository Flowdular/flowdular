import { createPortal, useEffect, useId, useRef, useState } from 'octane';
import { Icon } from '../icons/Icon.tsrx';

export interface ActionMenuItem {
	readonly id: string;
	readonly label: string;
	readonly icon?: string | undefined;
	readonly tone?: 'default' | 'danger' | undefined;
	readonly disabled?: boolean | undefined;
	readonly reason?: string | undefined;
	readonly onSelect: () => void;
}

export interface ActionMenuProps {
	readonly actions: readonly ActionMenuItem[];
	/** Accessible name of the trigger and the menu. */
	readonly label: string;
	/** Extra class on the trigger. */
	readonly triggerClass?: string | undefined;
}

function items(menu: HTMLElement | null): readonly HTMLElement[] {
	return menu === null
		? []
		: [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

/**
 * A row's actions behind one icon button. The menu renders into the document
 * body: the action column is sticky, and a sticky cell is a stacking context
 * the next row's cell would paint over. Arrows, Home and End move between
 * items, Enter or Space runs one, Escape and Tab close the menu and return focus
 * to the trigger. A refused action stays in the list, is announced as
 * unavailable and carries its reason.
 */
export function ActionMenu(props: ActionMenuProps) @{
	const id = useId();
	const [open, setOpen] = useState(false);
	const [placement, setPlacement] = useState<
		| {
				readonly top: number;
				readonly left: number;
		  }
		| null
	>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	/** Which item takes focus once the menu is on screen. */
	const startRef = useRef<'first' | 'last'>('first');

	const close = (restoreFocus: boolean) => {
		setOpen(false);
		setPlacement(null);
		if (restoreFocus) triggerRef.current?.focus();
	};

	const show = (start: 'first' | 'last') => {
		startRef.current = start;
		setOpen(true);
	};

	useEffect(() => {
		if (!open) return;
		const place = () => {
			const trigger = triggerRef.current;
			const menu = menuRef.current;
			if (trigger === null || menu === null) return;
			const anchor = trigger.getBoundingClientRect();
			const height = menu.offsetHeight;
			const width = menu.offsetWidth;
			const below = anchor.bottom + 4;
			setPlacement({
				top: below + height <= window.innerHeight - 8
					? below
					: Math.max(8, anchor.top - 4 - height),
				left: Math.max(
					8,
					Math.min(anchor.right - width, window.innerWidth - width - 8),
				),
			});
		};
		place();
		const list = items(menuRef.current);
		((startRef.current === 'last' ? list[list.length - 1] : list[0]))?.focus({
			preventScroll: true,
		});
		window.addEventListener('scroll', place, true);
		window.addEventListener('resize', place);
		return () => {
			window.removeEventListener('scroll', place, true);
			window.removeEventListener('resize', place);
		};
	}, [open]);

	const onTriggerKeyDown = (event: KeyboardEvent) => {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		show(event.key === 'ArrowUp' ? 'last' : 'first');
	};

	/* Escape closes the menu and stops there: a table inside a Drawer must not
   lose the drawer with the same keystroke. */
	const onMenuKeyDown = (event: KeyboardEvent) => {
		const list = items(menuRef.current);
		const index = list.indexOf(document.activeElement as HTMLElement);
		const move = (next: number) => {
			event.preventDefault();
			list[(next + list.length) % list.length]?.focus({ preventScroll: true });
		};
		if (event.key === 'ArrowDown') move(index + 1);
		else if (event.key === 'ArrowUp') move(index - 1);
		else if (event.key === 'Home') move(0);
		else if (event.key === 'End') move(list.length - 1);
		else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			close(true);
		} else if (event.key === 'Tab') {
			const trapped = event.defaultPrevented;
			if (!trapped) event.preventDefault();
			close(!trapped);
		}
	};

	const run = (action: ActionMenuItem) => {
		if (action.disabled === true) return;
		/* Focus goes back first, so a dialog the action opens returns it to the
	   trigger when it closes. */
		close(true);
		action.onSelect();
	};

	const entries = props.actions.map((action) => {
		const reason =
			action.disabled === true ? action.reason ?? '' : '';
		return {
			key: action.id,
			action,
			reason,
			reasonId: reason === '' ? undefined : id + '-' + action.id,
		};
	});

	@if (entries.length > 0) {
		<>
			<button
				class={[
					'ui-btn ui-btn--secondary ui-btn--sm ui-btn--icon ui-table-more',
					props.triggerClass,
				]}
				type="button"
				aria-label={props.label}
				title={props.label}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				ref={triggerRef}
				onClick={(event: MouseEvent) => {
					event.stopPropagation();
					if (open) close(false);
					else show('first');
				}}
				onKeyDown={onTriggerKeyDown}
			>
				<Icon name="more" size={16} />
			</button>
			@if (open) {
				<>
					{createPortal(
						<div
							class="ui-table-menu-layer"
							onClick={(event: MouseEvent) => event.stopPropagation()}
						>
							<div
								class="ui-table-menu__scrim"
								onClick={() => close(false)}
							></div>
							<div
								class="ui-menu ui-table-menu"
								id={id}
								role="menu"
								aria-label={props.label}
								style={placement === null
									? 'opacity: 0;'
									: `top: ${placement.top}px; left: ${placement.left}px;`}
								ref={menuRef}
								onKeyDown={onMenuKeyDown}
							>
								@for (const entry of entries; key entry.key) {
									<button
										class={[
											'ui-menu__item',
											entry.action.tone === 'danger' && 'ui-menu__item--danger',
										]}
										type="button"
										role="menuitem"
										tabindex={-1}
										aria-disabled={entry.action.disabled === true
											? 'true'
											: undefined}
										aria-describedby={entry.reasonId}
										title={entry.reason === '' ? undefined : entry.reason}
										onClick={() => run(entry.action)}
									>
										@if (entry.action.icon) {
											<Icon name={entry.action.icon} size={16} />
										}
										<span
											class="ui-table-menu__label"
										>{entry.action.label}</span>
									</button>
								}
								@for (const entry of entries; key entry.key) {
									@if (entry.reasonId) {
										<span
											class="ui-visually-hidden"
											id={entry.reasonId}
										>{entry.reason}</span>
									}
								}
							</div>
						</div>,
						document.body,
					)}
				</>
			}
		</>
	}
}
