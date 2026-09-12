import { activeTabId, nextTabId, type TabItem } from './tabs.ts';

export interface TabsProps {
	/** Required: tabs render as `<id>-tab-<item.id>` and point at the caller's `<id>-panel-<item.id>`. */
	readonly id: string;
	readonly items: readonly TabItem[];
	readonly active: string;
	readonly onChange: (id: string) => void;
	/** Accessible name of the tablist. */
	readonly label: string;
}

/**
 * The accessible tablist. Arrow keys move between tabs and Home and End jump
 * to the ends, skipping disabled tabs; only the active tab is in the tab
 * order, so Tab moves out of the list into the panel. An `active` that names no
 * enabled tab selects the first enabled one instead, so the list never falls
 * out of the tab order. The caller renders the panel, which keeps the tabs free
 * of any assumption about the content.
 */
export function Tabs(props: TabsProps) @{
	const selected = activeTabId(props.items, props.active);
	const onKeyDown = (event: KeyboardEvent) => {
		const next = nextTabId(props.items, selected, event.key);
		if (next === '' || next === selected) return;
		event.preventDefault();
		props.onChange(next);
		/* The tab already exists; only its tabindex changes on the next render,
   so focus can move to it now and roving focus stays with the reader. */
		document.getElementById(props.id + '-tab-' + next)?.focus();
	};

	<div
		class="ui-tabs"
		role="tablist"
		aria-label={props.label}
		onKeyDown={onKeyDown}
	>
		@for (const item of props.items; key item.id) {
			<button
				class={['ui-tabs__tab', item.id === selected && 'ui-tabs__tab--on']}
				type="button"
				role="tab"
				id={props.id + '-tab-' + item.id}
				aria-controls={props.id + '-panel-' + item.id}
				aria-selected={item.id === selected}
				tabindex={item.id === selected ? 0 : -1}
				disabled={item.disabled ?? false}
				onClick={() => props.onChange(item.id)}
			>{item.label}</button>
		}
	</div>
}
