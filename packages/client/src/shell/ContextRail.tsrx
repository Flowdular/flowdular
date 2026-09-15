import { Icon } from '@flowdular/ui';
import type {
	NavigationContribution,
	NavigationSection,
} from '../contributions.ts';
import type { ShellView } from '../state.ts';
import { t } from '../i18n/runtime.ts';
import { navigationSectionLabel, viewHref } from './navigation.ts';
import type { NavigateToView } from './types.ts';

export interface ContextRailProps {
	section: NavigationSection;
	items: readonly NavigationContribution[];
	activeView: ShellView;
	workspaceSlug: string | null;
	collapsed: boolean;
	onNavigate: NavigateToView;
	onToggle: () => void;
}

/* The second column beside the sidebar: the screens of the section the open
   view belongs to. It exists only while a sectioned view is open, and the
   workspace makes room for it. */
export function ContextRail(props: ContextRailProps) @{
	<nav
		class={['context-rail', props.collapsed && 'context-rail--collapsed']}
		aria-label={t('shell.nav.context')}
	>
		<div class="context-rail__head">
			<div class="context-rail__title">{navigationSectionLabel(
				t,
				props.section,
			)}</div>
			<button
				class="context-rail__toggle ui-btn ui-btn--ghost ui-btn--icon"
				type="button"
				aria-expanded={!props.collapsed}
				aria-label={t(
					props.collapsed ? 'shell.nav.context.show' : 'shell.nav.context.hide',
				)}
				title={t(
					props.collapsed ? 'shell.nav.context.show' : 'shell.nav.context.hide',
				)}
				onClick={props.onToggle}
			>
				<Icon
					name={props.collapsed ? 'chevron-right' : 'chevron-left'}
					size={16}
				/>
			</button>
		</div>
		<div class="context-rail__items" aria-hidden={props.collapsed}>
			@for (const item of props.items; key item.id) {
				<a
					class={[
						'nav-item',
						props.activeView === item.viewId && 'nav-item--active',
					]}
					href={viewHref(item.viewId, props.workspaceSlug)}
					title={item.description}
					onClick={(event) => {
						event.preventDefault();
						props.onNavigate(item.viewId);
					}}
				>
					<Icon name={item.glyph} size={18} />
					<span class="nav-item__label">{item.label}</span>
				</a>
			}
		</div>
	</nav>
}
