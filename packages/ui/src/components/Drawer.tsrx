import { useEffect } from 'octane';
import type { OctaneNode } from 'octane';
import { Icon } from '../icons/Icon.tsrx';

export type DrawerWidth = 'md' | 'lg';

export interface DrawerProps {
	open: boolean;
	title: string;
	subtitle?: string;
	/** md is a single-column form, lg fits two-column rows and editors. */
	width?: DrawerWidth;
	onClose: () => void;
	/** Use ui-drawer__form or ui-drawer__body as the direct child. */
	children?: OctaneNode;
}

export function Drawer(props: DrawerProps) @{
	useEffect(() => {
		if (!props.open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') props.onClose();
		};
		const restore = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		window.addEventListener('keydown', onKeyDown);
		return () => {
			document.body.style.overflow = restore;
			window.removeEventListener('keydown', onKeyDown);
		};
	}, [props.open]);

	<div class="ui-drawer-slot">
		@if (props.open) {
			<div
				class="ui-drawer"
				role="presentation"
				onClick={() => props.onClose()}
			>
				<aside
					class={[
						'ui-drawer__panel',
						props.width === 'lg' && 'ui-drawer__panel--lg',
					]}
					role="dialog"
					aria-modal="true"
					aria-label={props.title}
					onClick={(event: MouseEvent) => event.stopPropagation()}
				>
					<header class="ui-drawer__head">
						<span class="ui-cell">
							<b>{props.title}</b>
							@if (props.subtitle) {
								<small>{props.subtitle}</small>
							}
						</span>
						<button
							class="ui-drawer__close"
							type="button"
							aria-label="Close"
							onClick={() => props.onClose()}
						>
							<Icon name="x" size={16} />
						</button>
					</header>
					{props.children}
				</aside>
			</div>
		}
	</div>
}
